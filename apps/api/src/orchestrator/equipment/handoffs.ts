import { SysError } from '../../common/errors';
import type { EquipmentHandoff } from '../../generated/prisma/client';
import type { Tx } from '../../persistence';
import { handoffMetadataSchema, type RouterPlan } from '../../routing/router-gateway/result.types';
import { equipmentCapacity, equipmentTotal, readEquipmentSettings } from './equipment-policy';

/** API meeting view; confirmation timestamps describe facts, never predicted completion. */
export function handoffView(row: EquipmentHandoff) {
  return {
    id: row.id,
    donorEngineerId: row.donorEngineerId,
    receiverEngineerId: row.receiverEngineerId,
    requestId: row.requestId,
    items: stockItems(row.items),
    lat: row.lat,
    lon: row.lon,
    meetingAt: Number(row.meetingAt),
    donorConfirmedAt: numberOrNull(row.donorConfirmedAt),
    receiverConfirmedAt: numberOrNull(row.receiverConfirmedAt),
    completedAt: numberOrNull(row.completedAt),
  };
}
export type HandoffView = ReturnType<typeof handoffView>;

/** Accepts only synchronized same-region pairs; existing reservations cannot be rewritten. */
export async function persistHandoffs(
  tx: Tx,
  plan: RouterPlan,
  workDate: string,
  now: number,
): Promise<void> {
  const groups = new Map<
    string,
    Array<{ engineerId: string; stop: RouterPlan['routes'][number]['stops'][number] }>
  >();
  for (const route of plan.routes)
    for (const stop of route.stops) {
      if (stop.kind !== 'handoff') continue;
      if (!stop.handoff || stop.request_id !== null || stop.end_at - stop.start_at !== 300)
        throw invalid();
      const pair = groups.get(stop.handoff.handoff_id) ?? [];
      pair.push({ engineerId: route.engineer_id, stop });
      groups.set(stop.handoff.handoff_id, pair);
    }
  const pending = await tx.equipmentHandoff.findMany({ where: { workDate, completedAt: null } });
  for (const row of pending)
    if (!groups.has(row.id))
      throw new SysError(
        'VALIDATION_FAILED',
        'A plan cannot discard an accepted equipment meeting',
      );
  for (const [id, pair] of groups) {
    const a = pair[0];
    const b = pair[1];
    if (pair.length !== 2 || !a?.stop.handoff || !b?.stop.handoff) throw invalid();
    const h = a.stop.handoff;
    if (h.donor_engineer_id === h.receiver_engineer_id) throw invalid();
    if (
      JSON.stringify(h) !== JSON.stringify(b.stop.handoff) ||
      a.engineerId === b.engineerId ||
      ![a.engineerId, b.engineerId].includes(h.donor_engineer_id) ||
      ![a.engineerId, b.engineerId].includes(h.receiver_engineer_id) ||
      a.stop.start_at !== b.stop.start_at ||
      a.stop.location.lat !== b.stop.location.lat ||
      a.stop.location.lon !== b.stop.location.lon
    )
      throw invalid();
    const engineers = await tx.engineer.findMany({
      where: { id: { in: [a.engineerId, b.engineerId] } },
    });
    if (engineers.length !== 2 || engineers[0]?.region !== engineers[1]?.region) throw invalid();
    const existing = await tx.equipmentHandoff.findUnique({ where: { id } });
    if (existing) {
      if (
        existing.completedAt !== null ||
        existing.donorEngineerId !== h.donor_engineer_id ||
        existing.receiverEngineerId !== h.receiver_engineer_id ||
        existing.requestId !== h.request_id ||
        Number(existing.meetingAt) !== a.stop.start_at ||
        existing.lat !== a.stop.location.lat ||
        existing.lon !== a.stop.location.lon ||
        JSON.stringify(stockItems(existing.items)) !== JSON.stringify(h.items)
      )
        throw invalid();
      continue;
    }
    await tx.equipmentHandoff.create({
      data: {
        id,
        workDate,
        donorEngineerId: h.donor_engineer_id,
        receiverEngineerId: h.receiver_engineer_id,
        requestId: h.request_id,
        items: h.items,
        lat: a.stop.location.lat,
        lon: a.stop.location.lon,
        meetingAt: BigInt(a.stop.start_at),
        createdAt: BigInt(now),
      },
    });
  }
}

/** Rejects skipping any earlier unconfirmed meeting, including through legacy request actions. */
export async function assertNoPendingHandoff(
  tx: Tx,
  engineerId: string,
  requestId: string,
  now?: number,
): Promise<void> {
  const pointer = await tx.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } });
  if (!pointer) return;
  const route = await tx.appliedPlanRoute.findFirst({
    where: { planId: pointer.planId, engineerId },
    include: { stops: true },
  });
  const target = route?.stops.find((stop) => stop.requestId === requestId);
  if (!target) return;
  for (const stop of route?.stops ?? []) {
    if (stop.kind !== 'handoff' || stop.sequence >= target.sequence) continue;
    const metadata = handoffMetadataSchema.safeParse(stop.handoff);
    if (!metadata.success) throw invalid();
    const row = await tx.equipmentHandoff.findUnique({ where: { id: metadata.data.handoff_id } });
    if (
      row &&
      (row.completedAt === null ||
        (now !== undefined && now < Math.max(Number(row.completedAt), Number(row.meetingAt) + 300)))
    )
      throw new SysError(
        'VALIDATION_FAILED',
        'Both engineers must confirm the equipment meeting first',
      );
  }
}

/** Serializes two authenticated confirmations and moves physical stock once, in the same transaction. */
export async function confirmHandoff(
  tx: Tx,
  id: string,
  engineerId: string,
  workDate: string,
  now: number,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM equipment_handoffs WHERE id = ${id} FOR UPDATE`;
  const row = await tx.equipmentHandoff.findUnique({ where: { id } });
  if (!row || row.workDate !== workDate) throw SysError.notFound('Equipment meeting');
  if (engineerId !== row.donorEngineerId && engineerId !== row.receiverEngineerId)
    throw SysError.forbidden('This meeting belongs to other engineers');
  if (row.donorEngineerId === row.receiverEngineerId) throw invalid();
  if (row.completedAt !== null) return;
  if (now < Number(row.meetingAt))
    throw new SysError('VALIDATION_FAILED', 'The equipment meeting has not started');
  const pointer = await tx.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } });
  const route =
    pointer &&
    (await tx.appliedPlanRoute.findFirst({
      where: { planId: pointer.planId, engineerId },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    }));
  const meeting = route?.stops.find(
    (stop) =>
      stop.kind === 'handoff' &&
      handoffMetadataSchema.safeParse(stop.handoff).data?.handoff_id === id,
  );
  if (!route || !meeting) throw invalid();
  for (const stop of route.stops.filter(
    (stop) => stop.sequence < meeting.sequence && stop.requestId,
  )) {
    const job = await tx.request.findUnique({
      where: { id: stop.requestId ?? '' },
      include: { liveStates: true },
    });
    if (
      job &&
      !['completed', 'cancelled'].includes(job.lifecycle) &&
      !job.liveStates.some((state) => state.assumedCompletedAt !== null)
    ) {
      throw new SysError(
        'VALIDATION_FAILED',
        'Complete the preceding visit before the equipment meeting',
      );
    }
  }
  const donor = row.donorConfirmedAt ?? (engineerId === row.donorEngineerId ? BigInt(now) : null);
  const receiver =
    row.receiverConfirmedAt ?? (engineerId === row.receiverEngineerId ? BigInt(now) : null);
  if (donor !== null && receiver !== null) {
    const ids = [row.donorEngineerId, row.receiverEngineerId].sort();
    for (const participant of ids)
      await tx.$queryRaw`SELECT id FROM engineer_days WHERE engineer_id = ${participant} AND work_date = ${workDate} FOR UPDATE`;
    const days = await tx.engineerDay.findMany({
      where: { engineerId: { in: ids }, workDate },
      include: { engineer: true },
    });
    const from = days.find((day) => day.engineerId === row.donorEngineerId);
    const to = days.find((day) => day.engineerId === row.receiverEngineerId);
    if (!from || !to) throw invalid();
    const stock = stockItems(row.items);
    const settings = await readEquipmentSettings(tx);
    const consumed = new Map(
      ids.map((participant) => [participant, { router: 0, set_top_box: 0, smart_speaker: 0 }]),
    );
    const facts = await tx.requestFact.findMany({
      where: {
        engineerId: { in: ids },
        kind: 'started',
        occurredAt: { gte: from.shiftStartAt, lte: from.shiftEndAt },
      },
      include: { request: true },
    });
    const counted = new Set<string>();
    for (const fact of facts)
      if (fact.engineerId && fact.request.requiredEquipment && !counted.has(fact.requestId)) {
        counted.add(fact.requestId);
        const quantities = consumed.get(fact.engineerId);
        if (quantities) quantities[fact.request.requiredEquipment] += 1;
      }
    const assumed = await tx.liveRequestState.findMany({
      where: {
        reservedEngineerId: { in: ids },
        assumedStartedAt: { not: null },
        workday: { workDate },
      },
      include: { request: true },
    });
    for (const state of assumed)
      if (
        state.reservedEngineerId &&
        state.request.requiredEquipment &&
        !counted.has(state.requestId)
      ) {
        counted.add(state.requestId);
        const quantities = consumed.get(state.reservedEngineerId);
        if (quantities) quantities[state.request.requiredEquipment] += 1;
      }
    const fromUsed = consumed.get(from.engineerId);
    const toUsed = consumed.get(to.engineerId);
    if (!fromUsed || !toUsed) throw invalid();
    if (
      from.equipmentRouter - fromUsed.router < stock.router ||
      from.equipmentSetTopBox - fromUsed.set_top_box < stock.set_top_box ||
      from.equipmentSmartSpeaker - fromUsed.smart_speaker < stock.smart_speaker
    )
      throw invalid();
    const remainingTo =
      equipmentTotal(to) - toUsed.router - toUsed.set_top_box - toUsed.smart_speaker;
    if (remainingTo + 1 > equipmentCapacity(to.engineer.transportType, settings))
      throw new SysError('VALIDATION_FAILED', 'The receiver cannot carry this equipment');
    await tx.engineerDay.update({
      where: { id: from.id },
      data: {
        equipmentRouter: { decrement: stock.router },
        equipmentSetTopBox: { decrement: stock.set_top_box },
        equipmentSmartSpeaker: { decrement: stock.smart_speaker },
        version: { increment: 1 },
      },
    });
    await tx.engineerDay.update({
      where: { id: to.id },
      data: {
        equipmentRouter: { increment: stock.router },
        equipmentSetTopBox: { increment: stock.set_top_box },
        equipmentSmartSpeaker: { increment: stock.smart_speaker },
        version: { increment: 1 },
      },
    });
  }
  await tx.equipmentHandoff.update({
    where: { id },
    data: {
      donorConfirmedAt: donor,
      receiverConfirmedAt: receiver,
      completedAt: donor !== null && receiver !== null ? BigInt(now) : null,
    },
  });
}

function stockItems(value: unknown) {
  return handoffMetadataSchema.shape.items.parse(value);
}
function numberOrNull(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
function invalid(): SysError {
  return new SysError('VALIDATION_FAILED', 'Invalid or changed equipment meeting');
}
