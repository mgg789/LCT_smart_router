import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { canonicalHash } from '../../common/json';
import type { Engineer, EngineerDay, Request } from '../../generated/prisma/client';
import { workDateOf } from '../../orchestrator/engineers/workday';
import { DEFAULT_POLICY_ID } from '../../orchestrator/policy/policy.catalog';
import type { Tx } from '../../persistence';
import {
  type RouterTaskSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotDiagnostics,
  type SnapshotEngineer,
  type SnapshotRequest,
} from './snapshot.types';

export interface BuiltSnapshot {
  readonly snapshot: RouterTaskSnapshot;
  readonly diagnostics: SnapshotDiagnostics;
  /**
   * Digest of the task content with `planning_as_of` left out.
   *
   * The published document is hashed whole, timestamp included, because that is what a
   * result is matched against. Answering "did the task change" needs the opposite: a
   * digest that ignores the moment of publication, so that republishing the same task a
   * second later is recognised as a no-op (context/33 section 7).
   */
  readonly taskFingerprint: string;
}

/**
 * Builds the whole current projection of the planning task.
 *
 * The sector is a **complete snapshot**, never a stream of create/update/delete
 * (context/33 section 5). Work that is finished, cancelled or already under way is
 * removed by sys before publication, which is why Router needs no business status for
 * each request.
 *
 * Everything the projection cannot represent is counted in diagnostics rather than
 * quietly dropped: a request the plan will never mention has to be explainable.
 */
@Injectable()
export class SnapshotBuilder {
  constructor(private readonly config: AppConfigService) {}

  async build(tx: Tx, planningAsOf: number): Promise<BuiltSnapshot> {
    const workDate = workDateOf(planningAsOf, this.config.get('APP_TIME_ZONE'));
    const previousDate = previousCalendarDate(workDate);
    const active = await tx.activePolicy.findUnique({ where: { id: 'singleton' } });
    const policyId = active?.policyId ?? DEFAULT_POLICY_ID;

    const rawDays = await tx.engineerDay.findMany({
      where: {
        OR: [
          { workDate },
          {
            workDate: previousDate,
            shiftEndAt: { gt: BigInt(planningAsOf) },
          },
        ],
      },
      include: { engineer: true },
      orderBy: { engineer: { inputOrder: 'asc' } },
    });
    // A shift that started yesterday is still the live day until it ends. After
    // midnight the calendar key rolls, but the Unix bounds do not — dropping those
    // rows emptied the published task (0 engineers) while the dashboard still listed
    // every imported crew.
    const days = pickCurrentDays(rawDays, workDate);

    const horizon = horizonOf(days, planningAsOf);
    const executionByEngineer = await this.executionAnchors(
      tx,
      days.map((day) => day.engineerId),
      horizon,
    );
    const equipmentByEngineer = await this.remainingEquipment(tx, days, horizon);

    const engineers: SnapshotEngineer[] = [];
    let engineersWithoutStartLocation = 0;
    let engineersWithoutShift = 0;
    let engineersOverrun = 0;
    for (const day of days) {
      if (day.engineer.archivedAt !== null) {
        continue;
      }
      // Covering extras stay on the map only while that policy is active. Otherwise
      // they leak into every strategy and flatten the comparison onto one roster.
      if (policyId !== 'covering' && day.engineer.id.startsWith('covering-')) {
        continue;
      }
      if (!hasShift(day)) {
        // The day row exists because the engineer acted -- went online, started lunch --
        // before the dispatcher set a shift. Without a shift there is no period to plan
        // in, and inventing one (a calendar day, say) would let work be scheduled at
        // three in the morning. Excluded and counted instead.
        engineersWithoutShift += 1;
        continue;
      }
      const execution = executionByEngineer.get(day.engineerId) ?? null;
      if (execution?.lifecycle === 'in_progress' && execution.overrunDetectedAt !== null) {
        // The timer only withdraws future capacity. It neither finishes the task nor
        // guesses when this engineer will become available again.
        engineersOverrun += 1;
        continue;
      }
      const projected = this.projectEngineer(
        day.engineer,
        day,
        execution,
        equipmentByEngineer.get(day.engineerId) ?? equipmentStockOf(day),
      );
      if (!projected) {
        engineersWithoutStartLocation += 1;
        continue;
      }
      engineers.push(projected);
    }

    const activeEngineers = await tx.engineer.count({ where: { archivedAt: null } });

    const candidates = await tx.request.findMany({
      // Only work available for a new distribution. Started, finished and cancelled work
      // is not returned to the free pool; its occupancy is expressed through the
      // engineer's start pair instead (context/33 section 5).
      where: {
        lifecycle: 'submitted',
        assignmentState: { in: ['pending', 'assigned', 'unassigned'] },
        startedAt: null,
      },
      orderBy: { arrivalOrder: 'asc' },
    });

    const requests: SnapshotRequest[] = [];
    let requestsWithoutLocation = 0;
    let requestsOutsideHorizon = 0;
    for (const request of candidates) {
      if (request.lat === null || request.lon === null) {
        // The address has not been geocoded. Inventing a point would put the work
        // somewhere it is not; excluding and counting it keeps the omission visible
        // (context/18 section 6.3).
        requestsWithoutLocation += 1;
        continue;
      }
      const windowStart = Number(request.windowStartAt);
      const windowEnd = Number(request.windowEndAt);
      if (windowEnd < horizon.start || windowStart > horizon.end) {
        // Work for another day. A window that merely lies in the past *within* this
        // horizon stays in: that is a reasoned non-assignment, not an exclusion
        // (context/33 section 10.2).
        requestsOutsideHorizon += 1;
        continue;
      }
      requests.push({
        request_id: request.id,
        region: request.region,
        arrival_order: request.arrivalOrder,
        location: { lat: request.lat, lon: request.lon },
        service_duration_sec: request.serviceDurationSec,
        window_start_at: windowStart,
        window_end_at: windowEnd,
        priority: request.priority,
        required_skill: request.requiredSkill,
        required_transport: request.requiredTransport,
        required_equipment: request.requiredEquipment,
      });
    }

    const snapshot: RouterTaskSnapshot = {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      planning_as_of: planningAsOf,
      horizon_start_at: horizon.start,
      horizon_end_at: horizon.end,
      requests,
      engineers,
      policy: {
        policy_id: policyId,
        parameters: {},
      },
    };

    const { planning_as_of: _publishedAt, ...task } = snapshot;

    return {
      snapshot,
      taskFingerprint: canonicalHash(task),
      diagnostics: {
        requestsIncluded: requests.length,
        engineersIncluded: engineers.length,
        requestsWithoutLocation,
        requestsOutsideHorizon,
        engineersWithoutStartLocation,
        engineersWithoutShift,
        engineersOverrun,
        engineersWithoutWorkday: Math.max(0, activeEngineers - days.length),
      },
    };
  }

  /**
   * Projects one engineer into a start pair.
   *
   * `start_location` is where the remaining route continues from and `available_from` is
   * the earliest moment it may continue *from that point*. The two belong together: an
   * ETA to some other address must never be written as the release time at this one, or
   * the travel is counted twice (context/33 section 5).
   *
   * There is no GPS in this projection. Geolocation is a voluntary collection and not an
   * input to routing, so the start comes from the profile or the depot
   * (context/37 section 5.3).
   *
   * Returns `null` when no usable start point exists. That is a problem in preparing the
   * input, and the contract is explicit that it does not license substituting an office
   * or zero coordinates.
   */
  private projectEngineer(
    engineer: Engineer,
    day: EngineerDay,
    execution: Request | null,
    equipmentStock: { router: number; set_top_box: number; smart_speaker: number },
  ): SnapshotEngineer | null {
    const lat = execution?.lat ?? engineer.homeLat;
    const lon = execution?.lon ?? engineer.homeLon;
    if (lat === null || lon === null) {
      return null;
    }

    const shiftStart = Number(day.shiftStartAt);
    /**
     * When the route may continue from this point.
     *
     * Deliberately **not** clamped to "now". The contract already says a new route starts
     * no earlier than `planning_as_of`, the shift and a known `available_from`, and Router
     * applies all three -- so folding the current moment in here adds nothing.
     *
     * It would also do real damage: a value that tracks the publication second makes the
     * projection different every second, which defeats the "do not republish an identical
     * task" check and turns `planning_as_of` into a ticking clock -- exactly what
     * context/33 section 7 forbids. This is a property of the engineer's state, not of the
     * moment we happen to publish.
     */
    const continuation = execution?.continuationAvailableAt ?? null;
    const availableFrom = continuation === null ? shiftStart : Number(continuation);

    return {
      engineer_id: engineer.id,
      region: engineer.region,
      input_order: engineer.inputOrder,
      skills: engineer.skills,
      transport_type: engineer.transportType,
      shift_start_at: shiftStart,
      shift_end_at: Number(day.shiftEndAt),
      start_location: { lat, lon },
      available_from: availableFrom,
      availability: day.availability,
      expected_online_at: nullableNumber(day.expectedOnlineAt),
      equipment_stock: equipmentStock,
      lunch_taken: day.lunchTaken,
      lunch: {
        enabled: day.lunchEnabled,
        duration_sec: day.lunchDurationSec,
        window_start_at: nullableNumber(day.lunchWindowStartAt),
        window_end_at: nullableNumber(day.lunchWindowEndAt),
        // A fact outranks a leftover requirement: once the lunch is used, `required` from
        // an earlier decision grants no second one (context/33 section 10.3).
        required: day.lunchTaken ? false : day.lunchRequired,
      },
    };
  }

  /**
   * Finds the latest confirmed task position for every engineer in this horizon.
   * Started work wins while it is active; after completion the finish position remains
   * the continuation point for later replans instead of snapping back to the depot.
   */
  private async executionAnchors(
    tx: Tx,
    engineerIds: string[],
    horizon: { start: number; end: number },
  ): Promise<Map<string, Request>> {
    if (engineerIds.length === 0) {
      return new Map();
    }
    const facts = await tx.requestFact.findMany({
      where: {
        engineerId: { in: engineerIds },
        kind: { in: ['started', 'finished'] },
      },
      include: { request: true },
      orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
    });
    const active = new Map<string, Request>();
    const completed = new Map<string, Request>();
    for (const fact of facts) {
      if (!fact.engineerId) {
        continue;
      }
      const occurredAt = Number(fact.occurredAt);
      const isActiveStart = fact.kind === 'started' && fact.request.lifecycle === 'in_progress';
      const isConfirmedFinish =
        fact.kind === 'finished' &&
        fact.request.lifecycle === 'completed' &&
        occurredAt >= horizon.start &&
        occurredAt <= horizon.end;
      if (isActiveStart && !active.has(fact.engineerId)) {
        active.set(fact.engineerId, fact.request);
      } else if (isConfirmedFinish && !completed.has(fact.engineerId)) {
        completed.set(fact.engineerId, fact.request);
      }
    }
    // Active work always wins, even if an earlier test/import left a more recent completed
    // fact. The invariant normally permits only one active task per engineer; this order
    // also keeps the projection conservative if historic data predates that guard.
    const anchors = new Map(completed);
    for (const [engineerId, request] of active) {
      anchors.set(engineerId, request);
    }
    return anchors;
  }

  /**
   * Subtracts equipment already consumed by a started visit from this engineer's stock.
   * A request is counted once even when it already has both started and finished facts.
   */
  private async remainingEquipment(
    tx: Tx,
    days: EngineerDay[],
    horizon: { start: number; end: number },
  ): Promise<Map<string, { router: number; set_top_box: number; smart_speaker: number }>> {
    const remaining = new Map(days.map((day) => [day.engineerId, equipmentStockOf(day)]));
    const engineerIds = days.map((day) => day.engineerId);
    if (engineerIds.length === 0) {
      return remaining;
    }
    const facts = await tx.requestFact.findMany({
      where: {
        engineerId: { in: engineerIds },
        kind: 'started',
        occurredAt: { gte: BigInt(horizon.start), lte: BigInt(horizon.end) },
      },
      include: { request: true },
      orderBy: { occurredAt: 'asc' },
    });
    const counted = new Set<string>();
    for (const fact of facts) {
      if (!fact.engineerId || !fact.request.requiredEquipment || counted.has(fact.requestId)) {
        continue;
      }
      counted.add(fact.requestId);
      const stock = remaining.get(fact.engineerId);
      if (!stock) {
        continue;
      }
      if (fact.request.requiredEquipment === 'router') stock.router = Math.max(0, stock.router - 1);
      if (fact.request.requiredEquipment === 'set_top_box') {
        stock.set_top_box = Math.max(0, stock.set_top_box - 1);
      }
      if (fact.request.requiredEquipment === 'smart_speaker') {
        stock.smart_speaker = Math.max(0, stock.smart_speaker - 1);
      }
    }
    return remaining;
  }
}

/**
 * The working period this task covers.
 *
 * Taken from the shifts actually in the day rather than from the clock: the horizon is
 * the period being planned, and it is explicitly not required to equal the moment of the
 * recalculation (context/33 section 5).
 */
function horizonOf(
  days: Array<EngineerDay & { engineer: Engineer }>,
  planningAsOf: number,
): { start: number; end: number } {
  // Only real shifts define the period. A day row with a zero-length shift means nobody
  // set one yet; including it would collapse the horizon to an instant and silently drop
  // every request, which is precisely the kind of invisible exclusion this builder exists
  // to avoid.
  const shifts = days.filter(hasShift);
  if (shifts.length === 0) {
    // No shifts at all: the task covers the next twenty-four hours and simply has no
    // engineers in it. Router answers with reasoned non-assignments, which is a correct
    // result rather than an error (context/33 section 8).
    return { start: planningAsOf, end: planningAsOf + 24 * 3600 };
  }
  const start = Math.min(...shifts.map((day) => Number(day.shiftStartAt)));
  const end = Math.max(...shifts.map((day) => Number(day.shiftEndAt)));
  return { start, end };
}

/** A working day only counts once someone has given it a shift with a duration. */
function hasShift(day: EngineerDay): boolean {
  return day.shiftEndAt > day.shiftStartAt;
}

/** Calendar day before `workDate` (`YYYY-MM-DD`), independent of the host timezone. */
export function previousCalendarDate(workDate: string): string {
  return new Date(Date.parse(`${workDate}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * One day row per engineer: today's row wins over a still-open overnight shift.
 */
function pickCurrentDays<T extends EngineerDay & { engineer: Engineer }>(
  days: readonly T[],
  workDate: string,
): T[] {
  const chosen = new Map<string, T>();
  for (const day of days) {
    const current = chosen.get(day.engineerId);
    if (!current || (day.workDate === workDate && current.workDate !== workDate)) {
      chosen.set(day.engineerId, day);
    }
  }
  return [...chosen.values()].sort(
    (left, right) => left.engineer.inputOrder - right.engineer.inputOrder,
  );
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

function equipmentStockOf(day: EngineerDay): {
  router: number;
  set_top_box: number;
  smart_speaker: number;
} {
  return {
    router: day.equipmentRouter,
    set_top_box: day.equipmentSetTopBox,
    smart_speaker: day.equipmentSmartSpeaker,
  };
}

export type { Request as RequestRow };
