import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { Skill, TransportType } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { type ParsedRegion, parseBrigades, parseSyntheticFile } from './dataset.parser';

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

/** Regions of the official dataset, in the order their files are listed. */
export const DATASET_REGIONS = ['east', 'southeast', 'south_central'] as const;
export type DatasetRegion = (typeof DATASET_REGIONS)[number];

/**
 * Imports the organisers' dataset.
 *
 * Three rules from context/37 section 9.1 shape the whole thing: the package is checked
 * before anything is applied; an error means **nothing** is applied, because a half-loaded
 * file leaves a state nobody chose; and repeating the same package creates no duplicates,
 * recognised by content and origin rather than by file name.
 *
 * What the dataset does not contain is as important as what it does. There is no engineer
 * directory, no durations, no priorities and no coordinates (context/18 section 6.3).
 * Crews, skills and transport are derived by stated rules and stored with
 * `origin = synthesized`; coordinates are not derived at all, because a plausible-looking
 * point is worse than a missing one.
 */
@Injectable()
export class DatasetImportService {
  private readonly logger = new Logger(DatasetImportService.name);

  constructor(private readonly publisher: SnapshotPublisher) {}

  /**
   * Loads one region.
   *
   * `datasetRoot` is passed in so a test can point at a fixture; the default is the
   * dataset committed to the repository.
   */
  async importRegion(
    context: OperationContext,
    region: DatasetRegion,
    datasetRoot: string,
    timeZoneOffsetSec: number,
  ): Promise<ImportSummary> {
    const syntheticPath = resolve(datasetRoot, `${region}_synthetic_data.csv`);
    const controlPath = resolve(datasetRoot, `${region}_control_distribution.csv`);
    if (!existsSync(syntheticPath) || !existsSync(controlPath)) {
      throw SysError.notFound('Dataset files for region', { region, datasetRoot });
    }

    const syntheticBytes = readFileSync(syntheticPath);
    const controlBytes = readFileSync(controlPath);

    // Origin and content, not the file name: reloading a renamed copy of the same data
    // must still be recognised as the same package.
    const source = `official-dataset:${region}`;
    const checksum = createHash('sha256').update(syntheticBytes).update(controlBytes).digest('hex');

    const already = await context.tx.importPackage.findUnique({
      where: { source_checksum: { source, checksum } },
    });
    if (already) {
      return {
        source,
        applied: false,
        requestsCreated: 0,
        requestsSkippedAsDuplicate: 0,
        engineersCreated: 0,
        depotsCreated: 0,
        requestsWithoutCoordinates: 0,
        warnings: ['This exact package has already been imported'],
        errors: [],
      };
    }

    const parsed = parseSyntheticFile(region, syntheticBytes, timeZoneOffsetSec);
    const brigades = parseBrigades(region, controlBytes);

    if (parsed.errors.length > 0) {
      // Nothing is written. Reporting what is wrong and applying the rest would leave a
      // silently partial dataset.
      return {
        source,
        applied: false,
        requestsCreated: 0,
        requestsSkippedAsDuplicate: 0,
        engineersCreated: 0,
        depotsCreated: 0,
        requestsWithoutCoordinates: 0,
        warnings: parsed.warnings,
        errors: parsed.errors,
      };
    }

    const geocoded = this.loadGeocodeSidecar(datasetRoot, region);
    const summary = await this.apply(context, source, checksum, parsed, brigades, geocoded);

    // The free pool and the set of engineers both changed, so the task changed.
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.DATA_IMPORTED,
    );

    this.logger.log(
      `Imported ${region}: ${summary.requestsCreated} requests, ` +
        `${summary.engineersCreated} engineers, ` +
        `${summary.requestsWithoutCoordinates} awaiting coordinates`,
    );
    return summary;
  }

  private async apply(
    context: OperationContext,
    source: string,
    checksum: string,
    parsed: ParsedRegion,
    brigades: ReturnType<typeof parseBrigades>,
    geocoded: Map<string, { lat: number; lon: number }>,
  ): Promise<ImportSummary> {
    const now = BigInt(context.now);
    let depotsCreated = 0;
    let depotId: string | null = null;

    if (parsed.depot) {
      const depot = await context.tx.depot.upsert({
        where: { region: parsed.depot.region },
        update: {},
        create: {
          region: parsed.depot.region,
          addressText: parsed.depot.addressText,
          // The office address has no coordinates either. It is stored as written.
          lat: geocoded.get(parsed.depot.addressText)?.lat ?? null,
          lon: geocoded.get(parsed.depot.addressText)?.lon ?? null,
          origin: 'import',
          createdAt: now,
        },
      });
      depotId = depot.id;
      depotsCreated = 1;
    }

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
      if (mapped) {
        continue;
      }

      const synthesized = synthesizeCrew(brigade.inputOrder);
      const engineer = await context.tx.engineer.create({
        data: {
          displayName: brigade.name,
          // Order of first appearance in the control file, which the baseline iterates in.
          inputOrder: brigade.inputOrder,
          skills: synthesized.skills,
          transportType: synthesized.transportType,
          region: brigade.region,
          depotId,
          // The crew starts from the regional office, which is the only start point the
          // dataset gives (context/18 section 6.4). Without its coordinates the engineer
          // is simply not yet plannable, and the snapshot says so.
          homeLat: null,
          homeLon: null,
          // Marked as derived: the dataset has no skills or transport at all.
          origin: 'synthesized',
          createdAt: now,
          updatedAt: now,
        },
      });
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

    let requestsCreated = 0;
    let duplicates = 0;
    let withoutCoordinates = 0;

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

      const point = geocoded.get(request.addressText);
      if (!point) {
        withoutCoordinates += 1;
      }

      const rows = await context.tx.$queryRaw<Array<{ value: bigint }>>`
        SELECT nextval('request_arrival_order_seq') AS value
      `;
      const arrivalOrder = Number(rows[0]?.value ?? 0);

      const created = await context.tx.request.create({
        data: {
          arrivalOrder,
          addressText: request.addressText,
          district: request.district,
          region: request.region,
          lat: point?.lat ?? null,
          lon: point?.lon ?? null,
          needsGeocoding: !point,
          serviceDurationSec: request.serviceDurationSec,
          windowStartAt: BigInt(request.windowStartAt),
          windowEndAt: BigInt(request.windowEndAt),
          windowOrigin: request.windowOrigin,
          priority: request.priority,
          requiredSkill: request.skill,
          requiredTransport: null,
          workTypeHd: request.workTypeCode,
          // Already in the system and available for distribution: these are real orders,
          // not drafts someone still has to confirm.
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
          requestsCreated,
          engineersCreated,
          depotsCreated,
          duplicates,
          withoutCoordinates,
          warnings: parsed.warnings.length,
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
      requestsWithoutCoordinates: withoutCoordinates,
      warnings: parsed.warnings,
      errors: [],
    };
  }

  /**
   * Optional address-to-point file supplied by the data zone.
   *
   * The dataset has only addresses, and geocoding is a separate task. When the file is
   * absent every imported request is marked `needsGeocoding` and excluded from the
   * published task with a counted diagnostic -- visible, not silently missing. When it
   * appears, the same importer fills the points with no code change here.
   */
  private loadGeocodeSidecar(
    datasetRoot: string,
    region: string,
  ): Map<string, { lat: number; lon: number }> {
    const path = resolve(datasetRoot, '..', 'geocoded', `${region}.json`);
    if (!existsSync(path)) {
      return new Map();
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<
        string,
        { lat: number; lon: number }
      >;
      return new Map(Object.entries(parsed));
    } catch (error) {
      this.logger.warn(
        `Ignoring unreadable geocode file for ${region}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }
}

/**
 * Derives a crew's qualification and transport.
 *
 * The dataset has neither, and the case statement allows deriving them by a stated rule
 * (context/18 section 6.3). The rule: rotate through skill combinations and transport
 * types so that all three skills and all four transports occur, deterministically by
 * position, so two imports of the same file always produce the same directory.
 *
 * This is the most openly invented part of the import, which is why every engineer it
 * creates carries `origin = synthesized`.
 */
function synthesizeCrew(inputOrder: number): {
  skills: Skill[];
  transportType: TransportType;
} {
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
