import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { SysError } from '../../common/errors';
import type { EquipmentType, Skill, TransportType } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import {
  normalizeAddress,
  type ParsedBrigade,
  type ParsedRegion,
  type ParsedRequest,
  parseBrigades,
  parseSyntheticFile,
} from './dataset.parser';

export interface ImportSummary {
  readonly source: string;
  readonly applied: boolean;
  readonly requestsCreated: number;
  readonly requestsSkippedAsDuplicate: number;
  readonly engineersCreated: number;
  readonly depotsCreated: number;
  readonly requestsWithoutCoordinates: number;
  readonly warnings: string[];
  readonly errors: string[];
}

export interface ImportBatchSummary extends ImportSummary {
  readonly regionResults: ReadonlyArray<ImportSummary & { readonly region: DatasetRegion }>;
}

/** Regions of the official dataset, in stable cross-region baseline order. */
export const DATASET_REGIONS = ['east', 'southeast', 'south_central'] as const;
export type DatasetRegion = (typeof DATASET_REGIONS)[number];

interface PreparedRegion {
  readonly region: DatasetRegion;
  readonly source: string;
  readonly checksum: string;
  readonly parsed: ParsedRegion;
  readonly brigades: ParsedBrigade[];
  readonly geocoded: Map<string, { lat: number; lon: number }>;
  readonly engineerLimit: number | null;
}

const geocodePackageSchema = z
  .object({
    schema_version: z.string().min(1).optional(),
    /** Compatibility name used by the prepared Core scenario resources. */
    version: z.string().min(1).optional(),
    region: z.enum(DATASET_REGIONS).optional(),
    source: z.string().min(1),
    entries: z
      .array(
        z.object({
          address: z.string().min(1),
          node_id: z.string().min(1).optional(),
          location: z.object({
            lat: z.number().min(-90).max(90),
            lon: z.number().min(-180).max(180),
          }),
          match_level: z.string().min(1).optional(),
          source: z.string().min(1).optional(),
        }),
      )
      .min(1),
  })
  .strict()
  .refine((value) => Boolean(value.schema_version ?? value.version), {
    message: 'A geocode package version is required',
  });

/**
 * Imports one or more official regions as one atomic planning-data operation.
 *
 * Every selected package is parsed and its versioned coordinate catalogue is validated
 * before the first database write. Request windows are rebased to a live planning
 * horizon while preserving their relative offsets, because the official files are a
 * historical benchmark and an import must remain runnable at any time of day.
 */
@Injectable()
export class DatasetImportService {
  private readonly logger = new Logger(DatasetImportService.name);

  constructor(private readonly publisher: SnapshotPublisher) {}

  /** Backwards-compatible one-region entry point. */
  async importRegion(
    context: OperationContext,
    region: DatasetRegion,
    datasetRoot: string,
    timeZoneOffsetSec: number,
  ): Promise<ImportSummary> {
    const result = await this.importRegions(context, [region], datasetRoot, timeZoneOffsetSec, {});
    return result.regionResults[0] ?? result;
  }

  /** Loads all selected regions and publishes the resulting task exactly once. */
  async importRegions(
    context: OperationContext,
    regions: readonly DatasetRegion[],
    datasetRoot: string,
    timeZoneOffsetSec: number,
    engineerCountPerRegion: Partial<Record<DatasetRegion, number>>,
  ): Promise<ImportBatchSummary> {
    const prepared = regions.map((region) =>
      this.prepareRegion(
        context,
        region,
        datasetRoot,
        timeZoneOffsetSec,
        engineerCountPerRegion[region] ?? null,
      ),
    );
    if (prepared.some((item) => item.parsed.errors.length > 0)) {
      return aggregate(
        prepared.map((item) => ({
          region: item.region,
          ...emptySummary(item.source, item.parsed.warnings, item.parsed.errors),
        })),
      );
    }

    const results: Array<ImportSummary & { region: DatasetRegion }> = [];
    for (const item of prepared) {
      const prior = await context.tx.importPackage.findFirst({ where: { source: item.source } });
      if (prior) {
        if (prior.checksum !== item.checksum) {
          throw new SysError(
            'VALIDATION_FAILED',
            'The region was already imported with a different package or engineer count',
            { details: { region: item.region, source: item.source } },
          );
        }
        results.push({
          region: item.region,
          ...emptySummary(item.source, ['This exact package has already been imported'], []),
        });
        continue;
      }
      results.push({
        region: item.region,
        ...(await this.apply(context, item, timeZoneOffsetSec)),
      });
    }

    if (results.some((item) => item.applied)) {
      await this.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.DATA_IMPORTED,
      );
    }

    const summary = aggregate(results);
    this.logger.log(
      `Imported ${regions.join(', ')}: ${summary.requestsCreated} requests, ` +
        `${summary.engineersCreated} engineers`,
    );
    return summary;
  }

  private prepareRegion(
    context: OperationContext,
    region: DatasetRegion,
    datasetRoot: string,
    timeZoneOffsetSec: number,
    engineerLimit: number | null,
  ): PreparedRegion {
    const syntheticPath = resolve(datasetRoot, `${region}_synthetic_data.csv`);
    const controlPath = resolve(datasetRoot, `${region}_control_distribution.csv`);
    if (!existsSync(syntheticPath) || !existsSync(controlPath)) {
      throw SysError.notFound('Dataset files for region', { region, datasetRoot });
    }

    const syntheticBytes = readFileSync(syntheticPath);
    const controlBytes = readFileSync(controlPath);
    const parsedSource = parseSyntheticFile(region, syntheticBytes, timeZoneOffsetSec);
    const parsed = rebaseToLiveHorizon(parsedSource, context.now);
    const allBrigades = parseBrigades(region, controlBytes);
    if (engineerLimit !== null && engineerLimit > allBrigades.length) {
      throw new SysError('VALIDATION_FAILED', 'Engineer count exceeds crews in the dataset', {
        details: { region, requested: engineerLimit, available: allBrigades.length },
      });
    }
    const brigades = allBrigades.slice(0, engineerLimit ?? allBrigades.length);
    const geocode = this.loadGeocodePackage(datasetRoot, region, parsedSource);

    const checksum = createHash('sha256')
      .update(syntheticBytes)
      .update('\0')
      .update(controlBytes)
      .update('\0')
      .update(geocode.bytes)
      .update('\0')
      .update('equipment-v0-1')
      .update('\0')
      .update(String(engineerLimit ?? 'all'))
      .digest('hex');

    return {
      region,
      source: `official-dataset:${region}`,
      checksum,
      parsed,
      brigades,
      geocoded: geocode.points,
      engineerLimit,
    };
  }

  private async apply(
    context: OperationContext,
    prepared: PreparedRegion,
    timeZoneOffsetSec: number,
  ): Promise<ImportSummary> {
    const { source, checksum, parsed, brigades, geocoded } = prepared;
    const now = BigInt(context.now);
    let depotsCreated = 0;
    let depotId: string | null = null;
    let depotPoint: { lat: number; lon: number } | null = null;
    const equipmentByBrigade = allocateMorningEquipment(parsed.requests, brigades);

    if (parsed.depot) {
      depotPoint = geocoded.get(normalizeAddress(parsed.depot.addressText)) ?? null;
      const existing = await context.tx.depot.findUnique({
        where: { region: parsed.depot.region },
      });
      const depot = await context.tx.depot.upsert({
        where: { region: parsed.depot.region },
        update: {
          addressText: parsed.depot.addressText,
          lat: depotPoint?.lat ?? null,
          lon: depotPoint?.lon ?? null,
        },
        create: {
          region: parsed.depot.region,
          addressText: parsed.depot.addressText,
          lat: depotPoint?.lat ?? null,
          lon: depotPoint?.lon ?? null,
          origin: 'import',
          createdAt: now,
        },
      });
      depotId = depot.id;
      depotsCreated = existing ? 0 : 1;
    }

    const horizonStart = Math.min(...parsed.requests.map((request) => request.windowStartAt));
    const horizonEnd = Math.max(...parsed.requests.map((request) => request.windowEndAt));
    const workDate = localDate(context.now, timeZoneOffsetSec);
    let engineersCreated = 0;
    for (const brigade of brigades) {
      const mapped = await context.tx.externalIdMap.findUnique({
        where: {
          source_entityType_externalId: {
            source,
            entityType: 'engineer',
            externalId: brigade.name,
          },
        },
      });
      let engineerId = mapped?.internalId ?? null;
      if (!engineerId) {
        const synthesized = synthesizeCrew(brigade.inputOrder);
        const rows = await context.tx.$queryRaw<Array<{ value: bigint }>>`
          SELECT nextval('engineer_input_order_seq') AS value
        `;
        const engineer = await context.tx.engineer.create({
          data: {
            displayName: brigade.name,
            inputOrder: Number(rows[0]?.value ?? 0),
            skills: synthesized.skills,
            transportType: synthesized.transportType,
            region: brigade.region,
            depotId,
            homeLat: depotPoint?.lat ?? null,
            homeLon: depotPoint?.lon ?? null,
            origin: 'synthesized',
            createdAt: now,
            updatedAt: now,
          },
        });
        engineerId = engineer.id;
        await context.tx.externalIdMap.create({
          data: {
            source,
            entityType: 'engineer',
            externalId: brigade.name,
            internalId: engineer.id,
            createdAt: now,
          },
        });
        engineersCreated += 1;
      }

      await context.tx.engineerDay.upsert({
        where: { engineerId_workDate: { engineerId, workDate } },
        update: {
          shiftStartAt: BigInt(horizonStart),
          shiftEndAt: BigInt(horizonEnd),
          updatedAt: now,
          ...equipmentByBrigade.get(brigade.name),
        },
        create: {
          engineerId,
          workDate,
          shiftStartAt: BigInt(horizonStart),
          shiftEndAt: BigInt(horizonEnd),
          lunchEnabled: false,
          lunchRequired: false,
          ...equipmentByBrigade.get(brigade.name),
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    let requestsCreated = 0;
    let duplicates = 0;
    for (const request of parsed.requests) {
      const mapped = await context.tx.externalIdMap.findUnique({
        where: {
          source_entityType_externalId: {
            source,
            entityType: 'request',
            externalId: request.externalId,
          },
        },
      });
      if (mapped) {
        duplicates += 1;
        continue;
      }
      const point = geocoded.get(normalizeAddress(request.addressText));
      if (!point) {
        throw new SysError('VALIDATION_FAILED', 'Validated geocode disappeared during import', {
          details: { region: prepared.region, address: request.addressText },
        });
      }
      const rows = await context.tx.$queryRaw<Array<{ value: bigint }>>`
        SELECT nextval('request_arrival_order_seq') AS value
      `;
      const created = await context.tx.request.create({
        data: {
          arrivalOrder: Number(rows[0]?.value ?? 0),
          addressText: request.addressText,
          district: request.district,
          region: request.region,
          lat: point.lat,
          lon: point.lon,
          needsGeocoding: false,
          normProfileCode: request.normProfileCode,
          normativeTravelDurationSec: request.normativeTravelDurationSec,
          technicalDurationSec: request.technicalDurationSec,
          documentationDurationSec: request.documentationDurationSec,
          serviceDurationSec: request.serviceDurationSec,
          windowStartAt: BigInt(request.windowStartAt),
          windowEndAt: BigInt(request.windowEndAt),
          windowOrigin: request.windowOrigin,
          priority: request.priority,
          requiredSkill: request.skill,
          requiredTransport: null,
          requiredEquipment: importedEquipment(request),
          workTypeHd: request.workTypeCode,
          lifecycle: 'submitted',
          assignmentState: 'pending',
          origin: 'import',
          createdAt: now,
          submittedAt: now,
          updatedAt: now,
        },
      });
      await context.tx.externalIdMap.create({
        data: {
          source,
          entityType: 'request',
          externalId: request.externalId,
          internalId: created.id,
          createdAt: now,
        },
      });
      requestsCreated += 1;
    }

    await context.tx.importPackage.create({
      data: {
        source,
        checksum,
        appliedAt: now,
        summary: {
          region: prepared.region,
          requestsCreated,
          engineersCreated,
          depotsCreated,
          duplicates,
          requestsWithoutCoordinates: 0,
          engineerLimit: prepared.engineerLimit,
          rebasedToWorkDate: workDate,
        },
      },
    });

    return {
      source,
      applied: true,
      requestsCreated,
      requestsSkippedAsDuplicate: duplicates,
      engineersCreated,
      depotsCreated,
      requestsWithoutCoordinates: 0,
      warnings: parsed.warnings,
      errors: [],
    };
  }

  /** Reads and completely validates the versioned offline coordinate catalogue. */
  private loadGeocodePackage(
    datasetRoot: string,
    region: DatasetRegion,
    parsed: ParsedRegion,
  ): { bytes: Buffer; points: Map<string, { lat: number; lon: number }> } {
    const path = resolve(datasetRoot, '..', 'geocoded', `${region}.json`);
    if (!existsSync(path)) {
      throw SysError.notFound('Geocode package for region', { region, path });
    }
    const bytes = readFileSync(path);
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new SysError('VALIDATION_FAILED', 'Geocode package is not valid JSON', {
        details: { region },
        cause: error,
      });
    }
    const result = geocodePackageSchema.safeParse(raw);
    if (!result.success) {
      throw new SysError('VALIDATION_FAILED', 'Geocode package has an invalid schema', {
        details: { region, issues: result.error.issues },
      });
    }
    if (result.data.region && result.data.region !== region) {
      throw new SysError('VALIDATION_FAILED', 'Geocode package region does not match its file', {
        details: { expected: region, actual: result.data.region },
      });
    }

    const points = new Map<string, { lat: number; lon: number }>();
    for (const entry of result.data.entries) {
      const address = normalizeAddress(entry.address);
      const previous = points.get(address);
      if (previous) {
        throw new SysError('VALIDATION_FAILED', 'Geocode package has a duplicate address', {
          details: { region, address },
        });
      }
      points.set(address, entry.location);
    }

    const required = new Set(
      parsed.requests.map((request) => normalizeAddress(request.addressText)),
    );
    if (parsed.depot) {
      required.add(normalizeAddress(parsed.depot.addressText));
    }
    const missing = [...required].filter((address) => !points.has(address));
    if (missing.length > 0) {
      throw new SysError('VALIDATION_FAILED', 'Geocode package does not cover the dataset', {
        details: { region, missingCount: missing.length, missing: missing.slice(0, 20) },
      });
    }
    return { bytes, points };
  }
}

/** Moves a historical benchmark to a future horizon without changing relative windows. */
function rebaseToLiveHorizon(parsed: ParsedRegion, now: number): ParsedRegion {
  const constrained = parsed.requests.filter(
    (request) =>
      request.windowOrigin !== 'declared_full_day' &&
      request.windowOrigin !== 'missing_treated_as_full_day',
  );
  const anchors = constrained.length > 0 ? constrained : parsed.requests;
  const sourceStart = Math.min(...anchors.map((request) => request.windowStartAt));
  const sourceEnd = Math.max(...anchors.map((request) => request.windowEndAt));
  const targetStart = now + 60;
  const targetEnd = targetStart + (sourceEnd - sourceStart);

  return {
    ...parsed,
    requests: parsed.requests.map((request) => {
      const wholeHorizon =
        request.windowOrigin === 'declared_full_day' ||
        request.windowOrigin === 'missing_treated_as_full_day';
      return {
        ...request,
        windowStartAt: wholeHorizon
          ? targetStart
          : targetStart + (request.windowStartAt - sourceStart),
        windowEndAt: wholeHorizon ? targetEnd : targetStart + (request.windowEndAt - sourceStart),
      };
    }),
  };
}

function localDate(now: number, offsetSec: number): string {
  return new Date((now + offsetSec) * 1000).toISOString().slice(0, 10);
}

function emptySummary(source: string, warnings: string[], errors: string[]): ImportSummary {
  return {
    source,
    applied: false,
    requestsCreated: 0,
    requestsSkippedAsDuplicate: 0,
    engineersCreated: 0,
    depotsCreated: 0,
    requestsWithoutCoordinates: 0,
    warnings,
    errors,
  };
}

function aggregate(
  regionResults: ReadonlyArray<ImportSummary & { readonly region: DatasetRegion }>,
): ImportBatchSummary {
  return {
    source:
      regionResults.length === 1
        ? (regionResults[0]?.source ?? 'official-dataset')
        : 'official-dataset:batch',
    applied: regionResults.some((item) => item.applied),
    requestsCreated: sum(regionResults, 'requestsCreated'),
    requestsSkippedAsDuplicate: sum(regionResults, 'requestsSkippedAsDuplicate'),
    engineersCreated: sum(regionResults, 'engineersCreated'),
    depotsCreated: sum(regionResults, 'depotsCreated'),
    requestsWithoutCoordinates: sum(regionResults, 'requestsWithoutCoordinates'),
    warnings: regionResults.flatMap((item) =>
      item.warnings.map((value) => `${item.region}: ${value}`),
    ),
    errors: regionResults.flatMap((item) => item.errors.map((value) => `${item.region}: ${value}`)),
    regionResults,
  };
}

function sum(
  summaries: ReadonlyArray<ImportSummary>,
  key:
    | 'requestsCreated'
    | 'requestsSkippedAsDuplicate'
    | 'engineersCreated'
    | 'depotsCreated'
    | 'requestsWithoutCoordinates',
): number {
  return summaries.reduce((total, item) => total + item[key], 0);
}

/** Deterministically derives qualifications and transport absent from the source files. */
function synthesizeCrew(inputOrder: number): { skills: Skill[]; transportType: TransportType } {
  const skillSets: Skill[][] = [
    ['connection'],
    ['connection', 'emergency'],
    ['local', 'connection'],
    ['emergency'],
    ['local', 'connection', 'emergency'],
    ['local'],
    ['connection', 'local'],
    ['emergency', 'connection'],
  ];
  const transports: TransportType[] = [
    'car',
    'car',
    'car',
    'walk',
    'car',
    'bike',
    'car',
    'transit',
  ];
  return {
    skills: skillSets[inputOrder % skillSets.length] ?? ['connection'],
    transportType: transports[inputOrder % transports.length] ?? 'car',
  };
}

interface EquipmentColumns {
  readonly equipmentRouter: number;
  readonly equipmentSetTopBox: number;
  readonly equipmentSmartSpeaker: number;
}

/**
 * Builds a deterministic morning issue from the whole region demand.
 *
 * Each equipment visit is placed into one compatible crew's provisional basket. A crew
 * then receives exactly its basket plus one spare for every equipment kind it uses. The
 * stock is persisted before Router runs, avoiding a circular "plan first, capacity later"
 * rule and giving replans a real per-engineer hard limit.
 */
function allocateMorningEquipment(
  requests: readonly ParsedRequest[],
  brigades: readonly ParsedBrigade[],
): Map<string, EquipmentColumns> {
  const demand = new Map(
    brigades.map((brigade) => [
      brigade.name,
      { equipmentRouter: 0, equipmentSetTopBox: 0, equipmentSmartSpeaker: 0 },
    ]),
  );
  const cursor = new Map<EquipmentType, number>();
  for (const request of requests) {
    const equipment = importedEquipment(request);
    if (!equipment) {
      continue;
    }
    const compatible = brigades.filter((brigade) =>
      synthesizeCrew(brigade.inputOrder).skills.includes(request.skill),
    );
    if (compatible.length === 0) {
      continue;
    }
    const position = cursor.get(equipment) ?? 0;
    const brigade = compatible[position % compatible.length];
    cursor.set(equipment, position + 1);
    if (!brigade) {
      continue;
    }
    const row = demand.get(brigade.name);
    if (!row) {
      continue;
    }
    if (equipment === 'router') row.equipmentRouter += 1;
    if (equipment === 'set_top_box') row.equipmentSetTopBox += 1;
    if (equipment === 'smart_speaker') row.equipmentSmartSpeaker += 1;
  }
  return new Map(
    [...demand].map(([name, row]) => [
      name,
      {
        equipmentRouter: row.equipmentRouter > 0 ? row.equipmentRouter + 1 : 0,
        equipmentSetTopBox: row.equipmentSetTopBox > 0 ? row.equipmentSetTopBox + 1 : 0,
        equipmentSmartSpeaker: row.equipmentSmartSpeaker > 0 ? row.equipmentSmartSpeaker + 1 : 0,
      },
    ]),
  );
}

/** Derives only demo equipment absent from the official files; the rule is stable. */
function importedEquipment(request: ParsedRequest): EquipmentType | null {
  if (
    request.workTypeCode === 'router_replacement' ||
    request.workTypeCode === 'connection_request'
  ) {
    return 'router';
  }
  if (request.workTypeCode === 'stb_replacement') {
    return 'set_top_box';
  }
  if (request.workTypeCode === 'equipment_order') {
    const variants: EquipmentType[] = ['router', 'set_top_box', 'smart_speaker'];
    const numericId = Number.parseInt(request.externalId, 10);
    return variants[Number.isFinite(numericId) ? numericId % variants.length : 0] ?? 'router';
  }
  if (request.workTypeCode === 'convergence') {
    const numericId = Number.parseInt(request.externalId, 10);
    return numericId % 5 === 0 ? 'smart_speaker' : null;
  }
  return null;
}
