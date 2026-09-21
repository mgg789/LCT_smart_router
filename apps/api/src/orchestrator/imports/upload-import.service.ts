import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { canonicalHash } from '../../common/json';
import type { EquipmentType, Skill, TransportType } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';

export interface UploadRequestInput {
  readonly externalId: string;
  readonly addressText: string;
  readonly lat: number;
  readonly lon: number;
  readonly serviceDurationSec: number;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly priority: 'normal' | 'urgent';
  readonly requiredSkill: Skill;
  readonly requiredTransport?: TransportType;
  readonly requiredEquipment?: EquipmentType;
  readonly workType?: string;
}

export interface UploadEngineerInput {
  readonly externalId: string;
  readonly displayName: string;
  readonly skills: Skill[];
  readonly transportType: TransportType;
  readonly start: { readonly lat: number; readonly lon: number };
  readonly shiftStartAt: number;
  readonly shiftEndAt: number;
}

export interface UploadDataPackageInput {
  readonly operationId: string;
  readonly schemaVersion: '1.0';
  readonly mode: 'new_region' | 'append_requests';
  readonly region: string;
  readonly sourceVersion: string;
  readonly requests: UploadRequestInput[];
  readonly engineers?: UploadEngineerInput[];
  readonly depot?: { readonly addressText: string; readonly lat: number; readonly lon: number };
}

export interface UploadDataPackageSummary {
  readonly applied: boolean;
  readonly region: string;
  readonly mode: 'new_region' | 'append_requests';
  readonly requestsCreated: number;
  readonly engineersCreated: number;
  readonly depotsCreated: number;
  readonly warnings: string[];
  readonly publicationId: string | null;
  readonly inputHash: string | null;
}

/** Applies a fully validated user package atomically and publishes one complete snapshot. */
@Injectable()
export class UploadImportService {
  constructor(private readonly publisher: SnapshotPublisher) {}

  async importPackage(
    context: OperationContext,
    input: UploadDataPackageInput,
    timeZoneOffsetSec: number,
  ): Promise<UploadDataPackageSummary> {
    const identitySource = `region:${input.region}`;
    const packageSource = `upload:${input.region}:${input.sourceVersion}`;
    const checksum = canonicalHash(packageContent(input));
    const exact = await context.tx.importPackage.findUnique({
      where: { source_checksum: { source: packageSource, checksum } },
    });
    if (exact) {
      const current = await context.tx.routingCurrent.findUnique({
        where: { id: 'singleton' },
        include: { snapshot: true },
      });
      return {
        applied: false,
        region: input.region,
        mode: input.mode,
        requestsCreated: 0,
        engineersCreated: 0,
        depotsCreated: 0,
        warnings: ['This exact package has already been imported'],
        publicationId: current?.snapshotId ?? null,
        inputHash: current?.snapshot.inputHash ?? null,
      };
    }
    const reusedVersion = await context.tx.importPackage.findFirst({
      where: { source: packageSource },
      select: { checksum: true },
    });
    if (reusedVersion) {
      throw new SysError(
        'VALIDATION_FAILED',
        'sourceVersion was already imported with different package content',
        { details: { region: input.region, sourceVersion: input.sourceVersion } },
      );
    }

    const [depot, requestCount, engineerCount] = await Promise.all([
      context.tx.depot.findUnique({ where: { region: input.region } }),
      context.tx.request.count({ where: { region: input.region } }),
      context.tx.engineer.count({ where: { region: input.region, archivedAt: null } }),
    ]);
    const regionExists = Boolean(depot) || requestCount > 0 || engineerCount > 0;
    const regionReadyForRequests = Boolean(depot) && engineerCount > 0;
    if (input.mode === 'new_region' && regionExists) {
      throw new SysError(
        'VALIDATION_FAILED',
        'The region already exists; append requests instead',
        {
          details: { region: input.region },
        },
      );
    }
    if (input.mode === 'append_requests' && !regionReadyForRequests) {
      throw SysError.notFound('Region with depot and active engineers', { region: input.region });
    }

    const checkedRequests = await this.validateExistingRequests(context, input, identitySource);
    if (input.mode === 'new_region') {
      await this.validateEngineerIds(context, input, identitySource);
    }

    const now = BigInt(context.now);
    let depotId = depot?.id ?? null;
    let depotsCreated = 0;
    if (input.mode === 'new_region') {
      const nextDepot = input.depot;
      if (!nextDepot) throw new SysError('VALIDATION_FAILED', 'New region depot is required');
      const created = await context.tx.depot.create({
        data: {
          region: input.region,
          addressText: nextDepot.addressText,
          lat: nextDepot.lat,
          lon: nextDepot.lon,
          origin: 'import',
          createdAt: now,
        },
      });
      depotId = created.id;
      depotsCreated = 1;
    }

    let engineersCreated = 0;
    if (input.mode === 'new_region') {
      const engineers = input.engineers ?? [];
      const equipment = allocateUploadedEquipment(input.requests, engineers);
      for (const engineerInput of engineers) {
        const rows = await context.tx.$queryRaw<Array<{ value: bigint }>>`
          SELECT nextval('engineer_input_order_seq') AS value
        `;
        const engineer = await context.tx.engineer.create({
          data: {
            displayName: engineerInput.displayName,
            inputOrder: Number(rows[0]?.value ?? 0),
            skills: engineerInput.skills,
            transportType: engineerInput.transportType,
            depotId,
            homeLat: engineerInput.start.lat,
            homeLon: engineerInput.start.lon,
            region: input.region,
            origin: 'import',
            createdAt: now,
            updatedAt: now,
          },
        });
        await context.tx.externalIdMap.create({
          data: {
            source: identitySource,
            entityType: 'engineer',
            externalId: engineerInput.externalId,
            internalId: engineer.id,
            createdAt: now,
          },
        });
        const workDate = localDate(engineerInput.shiftStartAt, timeZoneOffsetSec);
        const lunch = localLunchWindow(workDate, timeZoneOffsetSec);
        const stock = equipment.get(engineerInput.externalId) ?? emptyEquipment();
        await context.tx.engineerDay.create({
          data: {
            engineerId: engineer.id,
            workDate,
            shiftStartAt: BigInt(engineerInput.shiftStartAt),
            shiftEndAt: BigInt(engineerInput.shiftEndAt),
            lunchEnabled: true,
            lunchDurationSec: 30 * 60,
            lunchWindowStartAt: BigInt(lunch.start),
            lunchWindowEndAt: BigInt(lunch.end),
            lunchRequired: false,
            equipmentRouter: stock.equipmentRouter,
            equipmentSetTopBox: stock.equipmentSetTopBox,
            equipmentSmartSpeaker: stock.equipmentSmartSpeaker,
            createdAt: now,
            updatedAt: now,
          },
        });
        engineersCreated += 1;
      }
    }

    let requestsCreated = 0;
    for (const request of checkedRequests) {
      if (request.duplicate) continue;
      const rows = await context.tx.$queryRaw<Array<{ value: bigint }>>`
        SELECT nextval('request_arrival_order_seq') AS value
      `;
      const created = await context.tx.request.create({
        data: {
          arrivalOrder: Number(rows[0]?.value ?? 0),
          addressText: request.input.addressText,
          region: input.region,
          lat: request.input.lat,
          lon: request.input.lon,
          needsGeocoding: false,
          normProfileCode: request.input.workType ?? 'uploaded',
          normativeTravelDurationSec: 0,
          technicalDurationSec: request.input.serviceDurationSec,
          documentationDurationSec: 0,
          serviceDurationSec: request.input.serviceDurationSec,
          windowStartAt: BigInt(request.input.windowStartAt),
          windowEndAt: BigInt(request.input.windowEndAt),
          windowOrigin: 'explicit',
          priority: request.input.priority,
          requiredSkill: request.input.requiredSkill,
          requiredTransport: request.input.requiredTransport ?? null,
          requiredEquipment: request.input.requiredEquipment ?? null,
          workTypeHd: request.input.workType ?? null,
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
          source: identitySource,
          entityType: 'request',
          externalId: request.input.externalId,
          internalId: created.id,
          createdAt: now,
        },
      });
      requestsCreated += 1;
    }

    const duplicateCount = checkedRequests.length - requestsCreated;
    await context.tx.importPackage.create({
      data: {
        source: packageSource,
        checksum,
        appliedAt: now,
        summary: {
          schemaVersion: input.schemaVersion,
          sourceVersion: input.sourceVersion,
          mode: input.mode,
          region: input.region,
          requestsCreated,
          engineersCreated,
          depotsCreated,
          requestsSkippedAsDuplicate: duplicateCount,
        },
      },
    });
    const publication = await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.DATA_IMPORTED,
    );
    return {
      applied: true,
      region: input.region,
      mode: input.mode,
      requestsCreated,
      engineersCreated,
      depotsCreated,
      warnings:
        duplicateCount === 0
          ? []
          : [`${duplicateCount} unchanged request external IDs were already imported`],
      publicationId: publication.snapshotId,
      inputHash: publication.inputHash,
    };
  }

  private async validateExistingRequests(
    context: OperationContext,
    input: UploadDataPackageInput,
    identitySource: string,
  ): Promise<Array<{ input: UploadRequestInput; duplicate: boolean }>> {
    const sources = [identitySource, `official-dataset:${input.region}`];
    const result: Array<{ input: UploadRequestInput; duplicate: boolean }> = [];
    for (const request of input.requests) {
      const mapping = await context.tx.externalIdMap.findFirst({
        where: {
          source: { in: sources },
          entityType: 'request',
          externalId: request.externalId,
        },
      });
      if (!mapping) {
        result.push({ input: request, duplicate: false });
        continue;
      }
      const stored = await context.tx.request.findUnique({ where: { id: mapping.internalId } });
      if (!stored || !sameRequest(stored, request, input.region)) {
        throw new SysError(
          'VALIDATION_FAILED',
          'An existing request external ID has different data',
          { details: { region: input.region, externalId: request.externalId } },
        );
      }
      result.push({ input: request, duplicate: true });
    }
    return result;
  }

  private async validateEngineerIds(
    context: OperationContext,
    input: UploadDataPackageInput,
    identitySource: string,
  ): Promise<void> {
    for (const engineer of input.engineers ?? []) {
      const mapping = await context.tx.externalIdMap.findFirst({
        where: {
          source: { in: [identitySource, `official-dataset:${input.region}`] },
          entityType: 'engineer',
          externalId: engineer.externalId,
        },
      });
      if (mapping) {
        throw new SysError('VALIDATION_FAILED', 'Engineer external ID already exists', {
          details: { region: input.region, externalId: engineer.externalId },
        });
      }
    }
  }
}

function packageContent(
  input: UploadDataPackageInput,
): Omit<UploadDataPackageInput, 'operationId'> {
  const { operationId: _operationId, ...content } = input;
  return content;
}

function sameRequest(
  stored: {
    addressText: string;
    region: string | null;
    lat: number | null;
    lon: number | null;
    serviceDurationSec: number;
    windowStartAt: bigint;
    windowEndAt: bigint;
    priority: string;
    requiredSkill: string;
    requiredTransport: string | null;
    requiredEquipment: string | null;
    workTypeHd: string | null;
  },
  input: UploadRequestInput,
  region: string,
): boolean {
  return (
    stored.addressText === input.addressText &&
    stored.region === region &&
    stored.lat === input.lat &&
    stored.lon === input.lon &&
    stored.serviceDurationSec === input.serviceDurationSec &&
    Number(stored.windowStartAt) === input.windowStartAt &&
    Number(stored.windowEndAt) === input.windowEndAt &&
    stored.priority === input.priority &&
    stored.requiredSkill === input.requiredSkill &&
    stored.requiredTransport === (input.requiredTransport ?? null) &&
    stored.requiredEquipment === (input.requiredEquipment ?? null) &&
    stored.workTypeHd === (input.workType ?? null)
  );
}

interface EquipmentColumns {
  equipmentRouter: number;
  equipmentSetTopBox: number;
  equipmentSmartSpeaker: number;
}

function emptyEquipment(): EquipmentColumns {
  return { equipmentRouter: 0, equipmentSetTopBox: 0, equipmentSmartSpeaker: 0 };
}

function allocateUploadedEquipment(
  requests: readonly UploadRequestInput[],
  engineers: readonly UploadEngineerInput[],
): Map<string, EquipmentColumns> {
  const result = new Map(engineers.map((engineer) => [engineer.externalId, emptyEquipment()]));
  const cursors = new Map<EquipmentType, number>();
  for (const request of requests) {
    const equipment = request.requiredEquipment;
    if (!equipment) continue;
    const compatible = engineers.filter(
      (engineer) =>
        engineer.skills.includes(request.requiredSkill) &&
        (request.requiredTransport === undefined ||
          engineer.transportType === request.requiredTransport),
    );
    if (compatible.length === 0) continue;
    const cursor = cursors.get(equipment) ?? 0;
    const engineer = compatible[cursor % compatible.length];
    cursors.set(equipment, cursor + 1);
    if (!engineer) continue;
    const stock = result.get(engineer.externalId);
    if (!stock) continue;
    if (equipment === 'router') stock.equipmentRouter += 1;
    if (equipment === 'set_top_box') stock.equipmentSetTopBox += 1;
    if (equipment === 'smart_speaker') stock.equipmentSmartSpeaker += 1;
  }
  for (const stock of result.values()) {
    if (stock.equipmentRouter > 0) stock.equipmentRouter += 1;
    if (stock.equipmentSetTopBox > 0) stock.equipmentSetTopBox += 1;
    if (stock.equipmentSmartSpeaker > 0) stock.equipmentSmartSpeaker += 1;
  }
  return result;
}

function localDate(seconds: number, offsetSec: number): string {
  return new Date((seconds + offsetSec) * 1000).toISOString().slice(0, 10);
}

function localLunchWindow(workDate: string, offsetSec: number): { start: number; end: number } {
  const midnightUtc = Date.parse(`${workDate}T00:00:00.000Z`) / 1000 - offsetSec;
  return { start: midnightUtc + 11 * 3600 + 20 * 60, end: midnightUtc + 15 * 3600 };
}
