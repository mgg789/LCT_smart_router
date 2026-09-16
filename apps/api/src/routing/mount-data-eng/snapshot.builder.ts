import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { canonicalHash } from '../../common/json';
import type { Engineer, EngineerDay, Request } from '../../generated/prisma/client';
import { workDateOf } from '../../orchestrator/engineers';
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

    const days = await tx.engineerDay.findMany({
      where: { workDate },
      include: { engineer: true },
      orderBy: { engineer: { inputOrder: 'asc' } },
    });

    const horizon = horizonOf(days, planningAsOf);

    const engineers: SnapshotEngineer[] = [];
    let engineersWithoutStartLocation = 0;
    let engineersWithoutShift = 0;
    for (const day of days) {
      if (day.engineer.archivedAt !== null) {
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
      const projected = this.projectEngineer(day.engineer, day);
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
        arrival_order: request.arrivalOrder,
        location: { lat: request.lat, lon: request.lon },
        service_duration_sec: request.serviceDurationSec,
        window_start_at: windowStart,
        window_end_at: windowEnd,
        priority: request.priority,
        required_skill: request.requiredSkill,
        required_transport: request.requiredTransport,
      });
    }

    const active = await tx.activePolicy.findUnique({ where: { id: 'singleton' } });

    const snapshot: RouterTaskSnapshot = {
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      planning_as_of: planningAsOf,
      horizon_start_at: horizon.start,
      horizon_end_at: horizon.end,
      requests,
      engineers,
      policy: {
        policy_id: active?.policyId ?? DEFAULT_POLICY_ID,
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
  private projectEngineer(engineer: Engineer, day: EngineerDay): SnapshotEngineer | null {
    if (engineer.homeLat === null || engineer.homeLon === null) {
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
    const availableFrom = shiftStart;

    return {
      engineer_id: engineer.id,
      input_order: engineer.inputOrder,
      skills: engineer.skills,
      transport_type: engineer.transportType,
      shift_start_at: shiftStart,
      shift_end_at: Number(day.shiftEndAt),
      start_location: { lat: engineer.homeLat, lon: engineer.homeLon },
      available_from: availableFrom,
      // The start came from the profile, not from an observation, so there is no
      // observation time to report. It does not confirm anyone's arrival anywhere.
      position_observed_at: null,
      availability: day.availability,
      expected_online_at: nullableNumber(day.expectedOnlineAt),
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

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

export type { Request as RequestRow };
