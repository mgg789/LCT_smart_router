import { SysError } from '../../common/errors';
import type { EquipmentLogistics } from '../../generated/prisma/client';
import type { Tx } from '../../persistence';
import {
  logisticsMetadataSchema,
  type RouterPlan,
} from '../../routing/router-gateway/result.types';
import { equipmentCapacity, equipmentTotal, readEquipmentSettings } from './equipment-policy';

/** Persist solver-created office pickups in the same transaction as their immutable plan. */
export async function persistLogistics(
  tx: Tx,
  plan: RouterPlan,
  workDate: string,
  now: number,
): Promise<void> {
  const seen = new Set<string>();
  for (const route of plan.routes)
    for (const stop of route.stops) {
      if (stop.kind !== 'delivery' && stop.kind !== 'office_pickup') continue;
      const metadata = logisticsMetadataSchema.parse(stop.logistics);
      if (
        stop.request_id !== null ||
        stop.end_at - stop.start_at !== 300 ||
        stop.kind !== (metadata.kind === 'donor_delivery' ? 'delivery' : 'office_pickup') ||
        route.engineer_id !==
          (metadata.kind === 'donor_delivery'
            ? metadata.donor_engineer_id
            : metadata.receiver_engineer_id)
      )
        throw new SysError('RESULT_NOT_APPLICABLE', 'Invalid equipment action owner or interval');
      if (seen.has(metadata.logistics_id))
        throw new SysError('RESULT_NOT_APPLICABLE', 'Duplicate equipment action');
      seen.add(metadata.logistics_id);
      const existing = await tx.equipmentLogistics.findUnique({
        where: { id: metadata.logistics_id },
      });
      if (existing) {
        if (
          existing.status !== 'assigned' ||
          existing.workDate !== workDate ||
          existing.kind !== metadata.kind ||
          existing.equipmentType !== metadata.equipment_type ||
          existing.donorEngineerId !== (metadata.donor_engineer_id ?? null) ||
          existing.receiverEngineerId !== metadata.receiver_engineer_id ||
          existing.depotId !== (metadata.depot_id ?? null) ||
          existing.lat !== stop.location.lat ||
          existing.lon !== stop.location.lon ||
          existing.requestId !== metadata.request_id ||
          existing.expectedAt !== BigInt(stop.start_at)
        )
          throw new SysError(
            'RESULT_NOT_APPLICABLE',
            'Equipment action no longer matches its reservation',
          );
        continue;
      }
      if (
        stop.kind !== 'office_pickup' ||
        !metadata.depot_id ||
        metadata.receiver_engineer_id !== route.engineer_id
      )
        throw new SysError('RESULT_NOT_APPLICABLE', 'Unreserved equipment delivery');
      const request = await tx.request.findUnique({ where: { id: metadata.request_id } });
      const depot = await tx.depot.findUnique({ where: { id: metadata.depot_id } });
      const job = route.stops.find(
        (item) => item.kind === 'job' && item.request_id === metadata.request_id,
      );
      if (
        request?.lifecycle !== 'submitted' ||
        request.requiredEquipment !== metadata.equipment_type ||
        !depot ||
        depot.lat !== stop.location.lat ||
        depot.lon !== stop.location.lon ||
        !job ||
        job.start_at < stop.end_at
      )
        throw new SysError('RESULT_NOT_APPLICABLE', 'Invalid office pickup witness');
      await tx.equipmentLogistics.create({
        data: {
          id: metadata.logistics_id,
          kind: 'office_pickup',
          status: 'assigned',
          workDate,
          requestId: metadata.request_id,
          equipmentType: metadata.equipment_type,
          receiverEngineerId: route.engineer_id,
          depotId: metadata.depot_id,
          lat: stop.location.lat,
          lon: stop.location.lon,
          expectedAt: BigInt(stop.start_at),
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
    }
  const pending = await tx.equipmentLogistics.findMany({ where: { workDate, status: 'assigned' } });
  if (pending.some((row) => !seen.has(row.id)))
    throw new SysError('RESULT_NOT_APPLICABLE', 'A pending equipment action was removed');
}

/** Durable, role-sensitive projection for the one-sided logistics cards. */
export function logisticsView(
  row: EquipmentLogistics,
  viewerId: string | null,
  donorName: string | null,
  now = 0,
) {
  const donorAction = row.kind === 'donor_delivery' && viewerId === row.donorEngineerId;
  const pickupAction = row.kind === 'office_pickup' && viewerId === row.receiverEngineerId;
  return {
    id: row.id,
    kind: row.kind,
    state: row.status,
    requestId: row.requestId,
    equipmentType: row.equipmentType,
    donorEngineerId: row.donorEngineerId,
    donorName,
    receiverEngineerId: row.receiverEngineerId,
    depotId: row.depotId,
    expectedAt: row.expectedAt === null ? null : Number(row.expectedAt),
    actualAt: row.actualAt === null ? null : Number(row.actualAt),
    location: { lat: row.lat, lon: row.lon },
    action: donorAction
      ? {
          kind: 'equipment_delivery_confirm' as const,
          enabled:
            row.status === 'assigned' && row.expectedAt !== null && Number(row.expectedAt) <= now,
        }
      : pickupAction
        ? {
            kind: 'office_pickup_confirm' as const,
            enabled:
              row.status === 'assigned' && row.expectedAt !== null && Number(row.expectedAt) <= now,
          }
        : null,
    retryAt: row.retryAt === null ? null : Number(row.retryAt),
    failureCode:
      row.failureCode === 'ROUTER_UNAVAILABLE'
        ? ('ROUTER_UNAVAILABLE' as const)
        : row.failureCode === 'NO_FEASIBLE_LOGISTICS'
          ? ('NO_FEASIBLE_LOGISTICS' as const)
          : null,
  };
}

/** Complete a one-sided fact exactly once; a donor delivery is consumed by the active job. */
export async function confirmLogistics(
  tx: Tx,
  id: string,
  engineerId: string,
  workDate: string,
  now: number,
  expectedKind: 'donor_delivery' | 'office_pickup',
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM equipment_logistics WHERE id = ${id} FOR UPDATE`;
  const row = await tx.equipmentLogistics.findUnique({ where: { id } });
  if (!row || row.workDate !== workDate) throw SysError.notFound('Equipment logistics');
  if (row.kind !== expectedKind)
    throw SysError.forbidden('This confirmation does not match the logistics action');
  const owner = row.kind === 'donor_delivery' ? row.donorEngineerId : row.receiverEngineerId;
  if (owner !== engineerId)
    throw SysError.forbidden('This logistics action belongs to another engineer');
  if (row.status === 'completed') return;
  if (row.status !== 'assigned')
    throw new SysError('VALIDATION_FAILED', 'Equipment logistics is not assigned');
  if (row.expectedAt === null || now < Number(row.expectedAt))
    throw new SysError('VALIDATION_FAILED', 'The equipment stop has not been reached yet');
  if (
    await tx.request.findFirst({
      where: { lifecycle: 'in_progress', facts: { some: { engineerId, kind: 'started' } } },
      select: { id: true },
    })
  )
    throw new SysError('VALIDATION_FAILED', 'Finish your active visit before the equipment stop');
  await tx.$queryRaw`SELECT id FROM engineer_days WHERE engineer_id = ${engineerId} AND work_date = ${workDate} FOR UPDATE`;
  const day = await tx.engineerDay.findUnique({
    where: { engineerId_workDate: { engineerId, workDate } },
    include: { engineer: true },
  });
  if (!day) throw new SysError('VALIDATION_FAILED', 'Engineer workday is missing');
  const field =
    row.equipmentType === 'router'
      ? 'equipmentRouter'
      : row.equipmentType === 'set_top_box'
        ? 'equipmentSetTopBox'
        : 'equipmentSmartSpeaker';
  if (row.kind === 'donor_delivery') {
    const receiver = await tx.request.findUnique({ where: { id: row.requestId } });
    if (receiver?.lifecycle !== 'in_progress')
      throw new SysError('VALIDATION_FAILED', 'The receiving visit is no longer active');
    if (day[field] < 1)
      throw new SysError('VALIDATION_FAILED', 'Donor no longer has this equipment');
    // The receiver's visit has already started: never credit a phantom spare to their basket.
    await tx.engineerDay.update({
      where: { id: day.id },
      data: { [field]: { decrement: 1 }, version: { increment: 1 } },
    });
    if (
      row.baselineCompletionAt !== null &&
      row.waitStartedAt !== null &&
      receiver.startedAt !== null
    ) {
      const expected =
        Number(row.baselineCompletionAt) + Math.max(0, now - Number(row.waitStartedAt));
      const duration = expected - Number(receiver.startedAt);
      await tx.request.update({
        where: { id: receiver.id },
        data: {
          expectedCompletionAt: BigInt(expected),
          continuationAvailableAt: BigInt(expected),
          serviceDurationSec: duration,
          technicalDurationSec: Math.max(0, duration - receiver.documentationDurationSec),
          updatedAt: BigInt(now),
          version: { increment: 1 },
        },
      });
    }
  } else {
    const request = await tx.request.findUnique({
      where: { id: row.requestId },
      select: { lifecycle: true },
    });
    if (request?.lifecycle !== 'submitted')
      throw new SysError('VALIDATION_FAILED', 'The office pickup visit is no longer pending');
    const settings = await readEquipmentSettings(tx);
    if (equipmentTotal(day) >= equipmentCapacity(day.engineer.transportType, settings))
      throw new SysError('VALIDATION_FAILED', 'Engineer cannot carry the office equipment');
    await tx.engineerDay.update({
      where: { id: day.id },
      data: { [field]: { increment: 1 }, version: { increment: 1 } },
    });
  }
  await tx.equipmentLogistics.update({
    where: { id },
    data: {
      status: 'completed',
      actualAt: BigInt(now),
      consumedAt: row.kind === 'donor_delivery' ? BigInt(now) : null,
      updatedAt: BigInt(now),
    },
  });
}
