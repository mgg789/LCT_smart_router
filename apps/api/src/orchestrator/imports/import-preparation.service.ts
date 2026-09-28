import { randomUUID } from 'node:crypto';
import type { ImportPreparationView, ImportQualityFinding } from '@lct/shared';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { uploadDataPackageSchema } from '../../api/dto/data.dto';
import type { Actor } from '../../auth';
import { SysError } from '../../common/errors';
import { canonicalHash, canonicalJson } from '../../common/json';
import type { ImportPreparation } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { lockWorkingSetGeneration } from '../../persistence';
import { readEquipmentSettings } from '../equipment/equipment-policy';
import { normalizeAddress } from './dataset.parser';
import {
  DatasetImportService,
  type DatasetRegion,
  type ImportBatchSummary,
} from './dataset-import.service';
import { analyzeImportQuality, type ImportQualityRequest } from './import-quality';
import { importStudentVersion, screenImportStudent } from './quality-student/student';
import {
  normalizeUploadPackage,
  type UploadDataPackageInput,
  type UploadDataPackageSummary,
  UploadImportService,
} from './upload-import.service';

const PREPARATION_TTL_SEC = 24 * 60 * 60;
type ImportConfirmationResult = UploadDataPackageSummary | ImportBatchSummary;
const QUALITY_VERSIONS = {
  rules: 'rules-v1',
  statistics: 'mad-log-v1',
  student: importStudentVersion,
  transform: 'import-business-priority-v2',
} as const;

const qualityVersionsSchema = z.object({
  rules: z.string(),
  statistics: z.string(),
  student: z.string(),
  transform: z.string(),
});

const officialRequestSchema = z.object({
  externalId: z.string(),
  workTypeCode: z.string(),
  workCategory: z.enum(['emergency', 'connection', 'service']),
  skill: z.enum(['local', 'connection', 'emergency']),
  normProfileCode: z.enum([
    'connection_base',
    'outage_tkd',
    'network_emergency',
    'equipment_order',
    'local_repair',
  ]),
  normativeTravelDurationSec: z.number(),
  technicalDurationSec: z.number(),
  documentationDurationSec: z.number(),
  serviceDurationSec: z.number(),
  priority: z.enum(['normal', 'urgent']),
  windowStartAt: z.number(),
  windowEndAt: z.number(),
  windowOrigin: z.enum(['explicit', 'declared_full_day', 'missing_treated_as_full_day']),
  district: z.string().nullable(),
  addressText: z.string(),
  region: z.enum(['east', 'southeast', 'south_central']),
});
const officialRegionSchema = z.object({
  region: z.enum(['east', 'southeast', 'south_central']),
  source: z.string(),
  checksum: z.string(),
  parsed: z.object({
    region: z.enum(['east', 'southeast', 'south_central']),
    requests: z.array(officialRequestSchema),
    brigades: z.array(z.object({ name: z.string(), region: z.string(), inputOrder: z.number() })),
    depot: z.object({ region: z.string(), addressText: z.string() }).nullable(),
    warnings: z.array(z.string()),
    errors: z.array(z.string()),
  }),
  brigades: z.array(z.object({ name: z.string(), region: z.string(), inputOrder: z.number() })),
  geocoded: z.record(z.string(), z.object({ lat: z.number(), lon: z.number() })),
  engineerLimit: z.number().nullable(),
});

const storedPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('upload'),
    package: uploadDataPackageSchema,
    timeZoneOffsetSec: z.number(),
    interpretationFingerprint: z.string(),
  }),
  z.object({
    kind: z.literal('official'),
    regions: z.array(officialRegionSchema),
    timeZoneOffsetSec: z.number(),
    interpretationFingerprint: z.string(),
  }),
]);

/** Owns immutable import previews and applies them only after explicit confirmation. */
@Injectable()
export class ImportPreparationService {
  constructor(
    private readonly datasets: DatasetImportService,
    private readonly uploads: UploadImportService,
  ) {}

  /** Stores a structurally validated upload package and an advisory quality report. */
  async prepareUpload(
    context: OperationContext,
    actor: Actor,
    input: UploadDataPackageInput,
    timeZoneOffsetSec: number,
  ): Promise<ImportPreparationView> {
    const sourceInput = input;
    input = normalizeUploadPackage(input);
    await lockWorkingSetGeneration(context.tx);
    const existingDepot =
      input.mode === 'append_requests'
        ? await context.tx.depot.findUnique({
            where: { region: input.region },
            select: { lat: true, lon: true },
          })
        : null;
    const depot = input.depot
      ? { lat: input.depot.lat, lon: input.depot.lon }
      : existingDepot?.lat !== null &&
          existingDepot?.lat !== undefined &&
          existingDepot.lon !== null
        ? { lat: existingDepot.lat, lon: existingDepot.lon }
        : undefined;
    const findings = analyzeImportQuality(
      input.requests.map((request) => ({ ...request })),
      depot,
    );
    const emergencies = input.requests.filter((request) => request.workCategory === 'emergency');
    if (emergencies.length > 0)
      findings.push({
        code: 'emergency_service_norm',
        layer: 'rules',
        count: emergencies.length,
        examples: emergencies.slice(0, 3).map((request) => request.externalId),
        message:
          'Аварии: норматив выполнения 100 минут, дорога считается отдельно. Приоритет перед подключениями и ремонтом.',
      });
    const studentRows = input.requests.flatMap((request) => {
      const score = screenImportStudent({
        address: request.addressText,
        windowMinutes: (request.windowEndAt - request.windowStartAt) / 60,
        hasCoordinates: Number.isFinite(request.lat) && Number.isFinite(request.lon),
      });
      return score === null ? [] : [{ id: request.externalId, score }];
    });
    appendStudentFinding(findings, studentRows);
    const batch = {
      kind: 'upload' as const,
      package: sourceInput,
      timeZoneOffsetSec,
      interpretationFingerprint: canonicalHash(await readEquipmentSettings(context.tx)),
    };
    const identityPackage = Object.fromEntries(
      Object.entries(sourceInput).filter(([key]) => key !== 'operationId'),
    );
    const identity = { ...batch, package: identityPackage };
    const source = `upload:${input.region}:${input.sourceVersion}`;
    return this.store(context, actor, source, batch, findings, identity);
  }

  /** Parses, rebases and geocodes the official regions once, then retains those rows. */
  async prepareOfficial(
    context: OperationContext,
    actor: Actor,
    regions: readonly DatasetRegion[],
    datasetRoot: string,
    timeZoneOffsetSec: number,
    engineerCountPerRegion: Partial<Record<DatasetRegion, number>>,
  ): Promise<ImportPreparationView> {
    await lockWorkingSetGeneration(context.tx);
    const prepared = this.datasets.prepareRegions(
      context,
      regions,
      datasetRoot,
      timeZoneOffsetSec,
      engineerCountPerRegion,
    );
    const errors = prepared.flatMap((region) => region.parsed.errors);
    if (errors.length > 0) {
      throw new SysError('VALIDATION_FAILED', 'Official dataset contains invalid rows', {
        details: { errors },
      });
    }
    const regionalFindings = prepared.map((region) => {
      const rows: ImportQualityRequest[] = region.parsed.requests.map((request) => {
        const point = region.geocoded[normalizeAddress(request.addressText)];
        if (!point)
          throw new SysError('VALIDATION_FAILED', 'Geocode is missing from prepared batch');
        return {
          externalId: request.externalId,
          addressText: request.addressText,
          lat: point.lat,
          lon: point.lon,
          serviceDurationSec: request.serviceDurationSec,
          windowStartAt: request.windowStartAt,
          windowEndAt: request.windowEndAt,
          district: request.district,
          allDayWindow:
            request.windowOrigin === 'declared_full_day' ||
            request.windowOrigin === 'missing_treated_as_full_day',
        };
      });
      const depot = region.parsed.depot
        ? region.geocoded[normalizeAddress(region.parsed.depot.addressText)]
        : undefined;
      return analyzeImportQuality(rows, depot).map((finding) => ({
        ...finding,
        examples: finding.examples.map((id) => `${region.region}:${id}`),
      }));
    });
    const rows = prepared.flatMap((region) =>
      region.parsed.requests.map((request) => ({ region, request })),
    );
    const findings = mergeFindings(regionalFindings.flat());
    const studentRows = rows.flatMap(({ region, request }) => {
      const score = screenImportStudent({
        address: request.addressText,
        windowMinutes: (request.windowEndAt - request.windowStartAt) / 60,
        hasCoordinates: Boolean(region.geocoded[normalizeAddress(request.addressText)]),
      });
      return score === null ? [] : [{ id: `${region.region}:${request.externalId}`, score }];
    });
    appendStudentFinding(findings, studentRows);
    const payload = {
      kind: 'official' as const,
      regions: prepared,
      timeZoneOffsetSec,
      interpretationFingerprint: canonicalHash(await readEquipmentSettings(context.tx)),
    };
    const source = `official-dataset:${regions.join(',')}`;
    return this.store(context, actor, source, payload, findings);
  }

  /** Atomically confirms a stored batch and returns its original result on retries. */
  async confirm(
    context: OperationContext,
    actor: Actor,
    prepareId: string,
  ): Promise<ImportConfirmationResult> {
    await lockWorkingSetGeneration(context.tx);
    const row = await this.findOwned(context, actor, prepareId);
    if (row.status === 'confirmed') return parseStoredResponse(row.response);
    if (row.status !== 'prepared')
      throw new SysError('VERSION_CONFLICT', 'Import preparation is no longer available');
    if (Number(row.expiresAt) <= context.now)
      throw new SysError(
        'VERSION_CONFLICT',
        'Import preparation has expired; prepare the file again',
      );

    if (canonicalHash(parseVersions(row.versions)) !== canonicalHash(QUALITY_VERSIONS))
      throw new SysError('VERSION_CONFLICT', 'Import logic changed; prepare the file again');

    const payload = parsePayload(row.payload);
    const equipmentSettings = await readEquipmentSettings(context.tx);
    if (payload.interpretationFingerprint !== canonicalHash(equipmentSettings)) {
      throw new SysError('VERSION_CONFLICT', 'Import rules changed; prepare the file again');
    }

    const claimed = await context.tx.importPreparation.updateMany({
      where: {
        id: row.id,
        ownerKind: actor.kind,
        ownerId: actor.id,
        status: 'prepared',
        expiresAt: { gt: BigInt(context.now) },
      },
      data: {
        status: 'confirmed',
        confirmedAt: BigInt(context.now),
        operationId: context.operationId,
      },
    });
    if (claimed.count !== 1) {
      const current = await this.findOwned(context, actor, prepareId);
      if (current.status === 'confirmed') return parseStoredResponse(current.response);
      throw new SysError('VERSION_CONFLICT', 'Import preparation changed; refresh and try again');
    }

    const response =
      payload.kind === 'upload'
        ? await this.uploads.importPackage(
            context,
            payload.package,
            payload.timeZoneOffsetSec,
            equipmentSettings,
          )
        : await this.datasets.importPreparedRegions(
            context,
            payload.regions,
            payload.timeZoneOffsetSec,
            equipmentSettings,
          );
    await context.tx.importPreparation.update({
      where: { id: row.id },
      data: { response: canonicalJson(response) },
    });
    return response;
  }

  /** Cancels a preparation without touching imported requests, engineers or routing state. */
  async cancel(
    context: OperationContext,
    actor: Actor,
    prepareId: string,
  ): Promise<{ cancelled: true }> {
    const row = await this.findOwned(context, actor, prepareId);
    if (row.status === 'cancelled') return { cancelled: true };
    if (row.status !== 'prepared')
      throw new SysError('VERSION_CONFLICT', 'A confirmed import cannot be cancelled');
    const cancelled = await context.tx.importPreparation.updateMany({
      where: { id: row.id, ownerKind: actor.kind, ownerId: actor.id, status: 'prepared' },
      data: { status: 'cancelled', cancelledAt: BigInt(context.now) },
    });
    if (cancelled.count !== 1) {
      const current = await this.findOwned(context, actor, prepareId);
      if (current.status === 'cancelled') return { cancelled: true };
      throw new SysError('VERSION_CONFLICT', 'A confirmed import cannot be cancelled');
    }
    return { cancelled: true };
  }

  private async store(
    context: OperationContext,
    actor: Actor,
    source: string,
    payload: unknown,
    findings: readonly ImportQualityFinding[],
    identityPayload: unknown = payload,
  ): Promise<ImportPreparationView> {
    const normalized = canonicalJson(payload);
    const immutableBatchHash = canonicalHash({
      source,
      payload: identityPayload,
      versions: QUALITY_VERSIONS,
    });
    const prepareId = randomUUID();
    const expiresAt = context.now + PREPARATION_TTL_SEC;
    const versions = QUALITY_VERSIONS;
    await context.tx.$executeRaw`
      DELETE FROM import_preparations
      WHERE id IN (
        SELECT id
        FROM import_preparations
        WHERE status IN ('prepared', 'cancelled') AND expires_at <= ${BigInt(context.now)}
        ORDER BY expires_at
        LIMIT 500
      )
    `;
    await context.tx.importPreparation.create({
      data: {
        id: prepareId,
        source,
        ownerKind: actor.kind,
        ownerId: actor.id,
        immutableBatchHash,
        versions: canonicalJson(versions),
        payload: normalized,
        findings: canonicalJson(findings),
        createdAt: BigInt(context.now),
        expiresAt: BigInt(expiresAt),
      },
    });
    return { prepareId, source, immutableBatchHash, versions, expiresAt, findings };
  }

  private async findOwned(
    context: OperationContext,
    actor: Actor,
    prepareId: string,
  ): Promise<ImportPreparation> {
    const row = await context.tx.importPreparation.findUnique({ where: { id: prepareId } });
    if (!row || row.ownerKind !== actor.kind || row.ownerId !== actor.id)
      throw SysError.notFound('Import preparation', { prepareId });
    return row;
  }
}

function parsePayload(payload: string): z.infer<typeof storedPayloadSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new SysError('INTERNAL_ERROR', 'Stored import preparation is unreadable');
  }
  const parsed = storedPayloadSchema.safeParse(decoded);
  if (!parsed.success) throw new SysError('INTERNAL_ERROR', 'Stored import preparation is invalid');
  return parsed.data;
}

function parseStoredResponse(response: string | null): ImportConfirmationResult {
  if (response === null)
    throw new SysError('INTERNAL_ERROR', 'Confirmed import has no stored result');
  try {
    // Only confirm() writes this result, using the same two import service contracts.
    return JSON.parse(response) as ImportConfirmationResult;
  } catch {
    throw new SysError('INTERNAL_ERROR', 'Stored import result is unreadable');
  }
}

function parseVersions(versions: string): z.infer<typeof qualityVersionsSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(versions);
  } catch {
    throw new SysError('INTERNAL_ERROR', 'Stored import versions are unreadable');
  }
  const parsed = qualityVersionsSchema.safeParse(decoded);
  if (!parsed.success) throw new SysError('INTERNAL_ERROR', 'Stored import versions are invalid');
  return parsed.data;
}

function appendStudentFinding(
  findings: ImportQualityFinding[],
  rows: readonly { readonly id: string; readonly score: number }[],
): void {
  if (rows.length === 0) return;
  const sorted = [...rows].sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id),
  );
  findings.push({
    code: 'student_suspicious_rows',
    layer: 'student',
    count: sorted.length,
    examples: sorted.slice(0, 3).map((item) => item.id),
    message: 'Локальная модель отметила несколько строк, которые можно проверить дополнительно.',
    score: Number((sorted[0]?.score ?? 0).toFixed(3)),
  });
}

function mergeFindings(findings: readonly ImportQualityFinding[]): ImportQualityFinding[] {
  const grouped = new Map<string, ImportQualityFinding[]>();
  for (const finding of findings) {
    const group = grouped.get(finding.code) ?? [];
    group.push(finding);
    grouped.set(finding.code, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, group]) => {
      const examples = [...new Set(group.flatMap((finding) => finding.examples))]
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 3);
      const score = Math.max(...group.map((finding) => finding.score ?? 0));
      return {
        code,
        layer: group[0]?.layer ?? 'rules',
        count: group.reduce((total, finding) => total + finding.count, 0),
        examples,
        message: group[0]?.message ?? '',
        ...(score > 0 ? { score } : {}),
      };
    });
}
