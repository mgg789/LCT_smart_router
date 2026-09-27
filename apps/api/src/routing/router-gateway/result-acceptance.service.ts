import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AppliedPlanCurrentShape } from '../../api/plan-view.types';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import { NotificationsService } from '../../notifications';
import type { Tx } from '../../persistence';
import { lockControlState, lockRoutingCurrent, PrismaService, UnitOfWork } from '../../persistence';
import { AppliedPlanService } from './applied-plan.service';
import { planSchema, type RouterPlan, type RouterResult, routerResultSchema } from './result.types';

export interface AcceptanceOutcome {
  readonly accepted: boolean;
  /** Why it was not accepted, as an error code from the catalogue. */
  readonly reason?: string;
  readonly detail?: string;
  readonly resultId?: string | null;
  readonly planRevision?: number;
}

/**
 * Applied-plan route legs are stored in the UI projection form.  Rebuild Router's
 * snake-case contract explicitly; a cast would persist an invalid package on the next
 * automatic revision and silently lose road geometry.
 */
function reverseStoredLegs(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const leg = z
      .object({
        legId: z.string().min(1),
        fromStopId: z.string().min(1).nullable(),
        toStopId: z.string().min(1),
        departureAt: z.number().int(),
        arrivalAt: z.number().int(),
        travelTimeSec: z.number().int().nonnegative(),
        distanceKm: z.number().nonnegative(),
        geometry: z
          .object({ points: z.array(z.object({ lat: z.number(), lon: z.number() })) })
          .nullable(),
        travelSource: z.enum(['approximate', 'road_matrix', 'route_api', 'traffic_api', 'metro']),
        trafficFactor: z.number().min(1),
        segments: z
          .array(
            z.object({
              geometry: z.object({
                points: z.array(z.object({ lat: z.number(), lon: z.number() })).min(2),
              }),
              travelSource: z.enum([
                'approximate',
                'road_matrix',
                'route_api',
                'traffic_api',
                'metro',
              ]),
              travelTimeSec: z.number().int().nonnegative(),
              distanceKm: z.number().nonnegative(),
            }),
          )
          .optional(),
      })
      .parse(raw);
    return {
      leg_id: leg.legId,
      from_stop_id: leg.fromStopId,
      to_stop_id: leg.toStopId,
      departure_at: leg.departureAt,
      arrival_at: leg.arrivalAt,
      travel_time_sec: leg.travelTimeSec,
      distance_km: leg.distanceKm,
      geometry: leg.geometry,
      travel_source: leg.travelSource,
      traffic_factor: leg.trafficFactor,
      ...(leg.segments
        ? {
            segments: leg.segments.map((segment) => ({
              geometry: segment.geometry,
              travel_source: segment.travelSource,
              duration_sec: segment.travelTimeSec,
              distance_m: Math.round(segment.distanceKm * 1000),
            })),
          }
        : {}),
    };
  });
}

/**
 * `ROUTER-gateway`: decides whether a finished result becomes the working plan.
 *
 * Five independent checks, all required, none substituting for another
 * (context/33 section 7):
 *
 *   1. the mode allows it -- in MANUAL the bus is disconnected;
 *   2. `input_publication_id` and `input_hash` both match the snapshot published *now*;
 *   3. `router_context_version` matches the version in force *now*;
 *   4. `main.is_usable` -- a finished answer is not automatically an applicable one;
 *   5. no conflict with explicit facts -- started, finished or cancelled work is not
 *      redistributed, and a used lunch is not planned again.
 *
 * When a result conflicts with the facts, sys does **not** repair it with an optimiser of
 * its own. It declines to apply it and publishes a current projection instead; choosing
 * assignments is Router's job and stays Router's job (context/33 section 7).
 */
@Injectable()
export class ResultAcceptanceService {
  private readonly logger = new Logger(ResultAcceptanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly plans: AppliedPlanService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Validates and, if everything holds, applies one result.
   *
   * `allowRepeatOfKnownResult` is the single exception the concept carves out: returning
   * to AUTO is an explicit transition that may apply a still-suitable result the system
   * has seen before. Ordinary re-reads never do (context/33 section 7).
   */
  async accept(
    raw: unknown,
    activeContextVersion: string | null,
    options: { allowRepeatOfKnownResult?: boolean } = {},
  ): Promise<AcceptanceOutcome> {
    const parsed = routerResultSchema.safeParse(raw);
    if (!parsed.success) {
      // A malformed package is a visible error, never a partly applied plan.
      throw new SysError('VALIDATION_FAILED', 'The Router result does not match the contract', {
        details: { issues: parsed.error.issues.slice(0, 10) },
      });
    }
    const result = parsed.data;

    if (result.status === 'pending') {
      return { accepted: false, reason: 'PENDING', detail: 'Router has no result yet' };
    }
    if (result.status === 'error') {
      // A visible error, not an endless spinner and not a mass refusal to customers
      // (context/33 section 10.5).
      await this.recordPackage(result, false, 'ROUTER_ERROR');
      return {
        accepted: false,
        reason: 'ROUTER_ERROR',
        detail: result.errors[0]?.message ?? 'Router reported an error',
      };
    }

    return this.uow.run(async (tx) => {
      // Both singletons are locked before anything is decided, so a result already in
      // flight cannot land after the dispatcher takes manual control.
      await lockControlState(tx);
      await lockRoutingCurrent(tx);

      const control = await tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
      if (control.mode === 'manual') {
        return this.reject(tx, result, 'MODE_MANUAL', 'Emergency manual mode is on');
      }

      const current = await tx.routingCurrent.findUnique({
        where: { id: 'singleton' },
        include: { snapshot: true },
      });
      if (!current) {
        return this.reject(tx, result, 'SNAPSHOT_STALE', 'No task has been published yet');
      }
      if (result.input_publication_id !== current.snapshot.id) {
        // Not a failure: the answer belongs to an earlier task and a newer one is on its
        // way. The interface keeps showing the last applied plan.
        return this.reject(
          tx,
          result,
          'SNAPSHOT_STALE',
          'The result names a publication that is no longer active',
        );
      }
      if (result.input_hash !== current.snapshot.inputHash) {
        return this.reject(
          tx,
          result,
          'SNAPSHOT_STALE',
          'The result belongs to snapshot bytes that are no longer published',
        );
      }
      if (result.router_context_version !== activeContextVersion) {
        return this.reject(
          tx,
          result,
          'RESULT_NOT_APPLICABLE',
          'The result used a map or technical context that is no longer active',
        );
      }
      if (!result.main?.is_usable) {
        // A finished answer that must not become the working plan. It does not prove that
        // the visits are impossible, and it does not cancel anything.
        return this.reject(
          tx,
          result,
          'RESULT_NOT_APPLICABLE',
          'The main plan is not usable and cannot become the working plan',
        );
      }

      const alreadyApplied = await tx.routerResult.findUnique({
        where: { resultId: result.result_id ?? '' },
      });
      if (alreadyApplied?.accepted && !options.allowRepeatOfKnownResult) {
        // Re-reading the same result does not apply it again, does not return completed
        // work to the pool and does not repeat a letter (context/33 section 7).
        return { accepted: false, reason: 'ALREADY_APPLIED', resultId: result.result_id };
      }

      // A free request can be deferred without rebuilding an unrelated LIVE route.
      // Even an unassigned outcome from the old snapshot must not overwrite it.
      const inputWindows = z
        .object({
          requests: z.array(
            z.object({
              request_id: z.string(),
              window_start_at: z.number(),
              window_end_at: z.number(),
              source_window_start_at: z.number().optional(),
              source_window_end_at: z.number().optional(),
            }),
          ),
        })
        .parse(JSON.parse(current.snapshot.payload));
      const requests = await tx.request.findMany({
        where: { id: { in: inputWindows.requests.map((request) => request.request_id) } },
        select: { id: true, windowStartAt: true, windowEndAt: true },
      });
      const windows = new Map(requests.map((request) => [request.id, request]));
      if (
        inputWindows.requests.some((input) => {
          const actual = windows.get(input.request_id);
          return (
            !actual ||
            Number(actual.windowStartAt) !==
              (input.source_window_start_at ?? input.window_start_at) ||
            Number(actual.windowEndAt) !== (input.source_window_end_at ?? input.window_end_at)
          );
        })
      )
        return this.reject(
          tx,
          result,
          'SNAPSHOT_STALE',
          'Request windows changed after publication',
        );

      const merged = await this.mergePartial(tx, result, current.snapshot.payload);
      if (merged.rejectionDetail) {
        return this.reject(tx, result, 'RESULT_NOT_APPLICABLE', merged.rejectionDetail);
      }
      const conflict = await this.conflictWithFacts(tx, merged.factCheck);
      if (conflict) {
        return this.reject(tx, result, 'RESULT_NOT_APPLICABLE', conflict);
      }

      const stored = await this.storePackage(tx, merged.applicable, true, null);
      const plan = await this.plans.applyAutomatic(
        tx,
        this.clock.nowSeconds(),
        merged.applicable,
        stored.id,
      );
      await this.recordAssignmentNotifications(tx, merged.applicable);

      this.logger.log(
        `Applied result ${result.result_id} as plan revision ${plan.revision}: ` +
          `${merged.applicable.main?.summary.assigned_count ?? 0}/${merged.applicable.main?.summary.requests_total ?? 0} assigned`,
      );

      return { accepted: true, resultId: result.result_id, planRevision: plan.revision };
    });
  }

  /**
   * Checks the proposed future against what has actually happened.
   *
   * A matching hash does not prove that nothing was executed since: live state and the
   * published snapshot are deliberately separate (context/32 section 3). So the plan is
   * compared with the facts before it is allowed to become the working plan.
   */
  /**
   * Merges a cumulative regional response with the part of the current plan Router has
   * not solved yet.  Applied-plan rows use UI-shaped JSON, so their legs are converted
   * back to the Router contract and validated before they can enter another revision.
   */
  private async mergePartial(
    tx: Tx,
    result: RouterResult,
    payload: string,
  ): Promise<{ applicable: RouterResult; factCheck: RouterResult; rejectionDetail?: string }> {
    if (result.status !== 'partial' || !result.main) {
      return { applicable: result, factCheck: result };
    }
    const input = z
      .object({
        requests: z.array(
          z.object({
            request_id: z.string(),
            region: z.string().nullable().optional(),
            priority: z.enum(['normal', 'urgent']).optional(),
          }),
        ),
        engineers: z.array(
          z.object({ engineer_id: z.string(), region: z.string().nullable().optional() }),
        ),
      })
      .parse(JSON.parse(payload));
    const ready = new Set(
      (result.regional_progress ?? [])
        .filter((item) => item.status === 'ready')
        .map((item) => item.region),
    );
    if (ready.size === 0) {
      return {
        applicable: result,
        factCheck: result,
        rejectionDetail: 'A partial result must identify at least one ready region',
      };
    }
    const requestRegion = new Map(
      input.requests.map((item) => [item.request_id, item.region ?? '__default__']),
    );
    const engineerRegion = new Map(
      input.engineers.map((item) => [item.engineer_id, item.region ?? '__default__']),
    );
    const unknownRoute = result.main.routes.find(
      (route) => !ready.has(engineerRegion.get(route.engineer_id) ?? ''),
    );
    if (unknownRoute) {
      return {
        applicable: result,
        factCheck: result,
        rejectionDetail: `Partial result contains an unready or unknown engineer route: ${unknownRoute.engineer_id}`,
      };
    }
    const unknownAssignment = result.main.assignments.find(
      (assignment) => !ready.has(requestRegion.get(assignment.request_id) ?? ''),
    );
    if (unknownAssignment) {
      return {
        applicable: result,
        factCheck: result,
        rejectionDetail: `Partial result contains an unready or unknown request: ${unknownAssignment.request_id}`,
      };
    }
    if (
      new Set(result.main.routes.map((route) => route.engineer_id)).size !==
        result.main.routes.length ||
      new Set(result.main.assignments.map((assignment) => assignment.request_id)).size !==
        result.main.assignments.length
    ) {
      return {
        applicable: result,
        factCheck: result,
        rejectionDetail: 'Partial result contains duplicate route or assignment identities',
      };
    }
    const previous = await this.plans.current(tx);
    if (!previous) return { applicable: result, factCheck: result };

    const stopIds = new Map(
      previous.assignments
        .filter((assignment) => assignment.stopId !== null)
        .map((assignment) => [assignment.requestId, assignment.stopId] as const),
    );
    const preservedRoutes = previous.routes
      .filter((route) => !ready.has(engineerRegion.get(route.engineerId) ?? '__default__'))
      .map((route) => ({
        engineer_id: route.engineerId,
        start_location: { lat: route.startLat, lon: route.startLon },
        start_at: route.startAt === null ? null : Number(route.startAt),
        finish_at: route.finishAt === null ? null : Number(route.finishAt),
        stops: route.stops.map((stop) => ({
          // Router stop ids are not materialised separately.  Job stops retain the
          // persisted assignment id; non-job stops receive a stable revision-local id.
          stop_id:
            stop.requestId === null
              ? `preserved:${route.engineerId}:${stop.sequence}`
              : (stopIds.get(stop.requestId) ?? `preserved:${route.engineerId}:${stop.sequence}`),
          sequence: stop.sequence,
          kind: stop.kind,
          request_id: stop.requestId,
          handoff: stop.handoff ?? null,
          location: { lat: stop.lat, lon: stop.lon },
          arrival_at: Number(stop.arrivalAt),
          start_at: Number(stop.startAt),
          end_at: Number(stop.endAt),
        })),
        legs: reverseStoredLegs(route.legs),
        lunch: {
          status: route.lunchStatus,
          stop_id:
            route.lunchStatus === 'scheduled'
              ? `preserved:${route.engineerId}:${route.stops.find((stop) => stop.kind === 'lunch')?.sequence ?? 0}`
              : null,
          reasons: [],
          alert_id: null,
        },
        metrics: {
          distance_km: route.distanceKm,
          travel_time_sec: route.travelTimeSec,
          work_time_sec: route.workTimeSec,
          waiting_time_sec: route.waitingTimeSec,
          lunch_time_sec: route.lunchTimeSec,
          assigned_count: route.assignedCount,
        },
        reasons: route.reasons,
      }));
    const preservedAssignments = previous.assignments
      .filter((item) => !ready.has(requestRegion.get(item.requestId) ?? '__default__'))
      .map((item) => ({
        request_id: item.requestId,
        status: item.status,
        engineer_id: item.engineerId,
        stop_id: item.stopId,
        reasons: item.reasons,
      }));
    const combinedRoutes = [...result.main.routes, ...preservedRoutes];
    const combinedAssignments = [...result.main.assignments, ...preservedAssignments];
    const urgentRequests = new Set(
      input.requests
        .filter((request) => request.priority === 'urgent')
        .map((request) => request.request_id),
    );
    const summary = {
      requests_total: combinedAssignments.length,
      assigned_count: combinedAssignments.filter((assignment) => assignment.status === 'assigned')
        .length,
      unassigned_count: combinedAssignments.filter(
        (assignment) => assignment.status === 'unassigned',
      ).length,
      urgent_total: combinedAssignments.filter((assignment) =>
        urgentRequests.has(assignment.request_id),
      ).length,
      urgent_assigned_count: combinedAssignments.filter(
        (assignment) =>
          assignment.status === 'assigned' && urgentRequests.has(assignment.request_id),
      ).length,
      engineers_used: combinedRoutes.filter((route) => route.metrics.assigned_count > 0).length,
      distance_km: combinedRoutes.reduce((sum, route) => sum + route.metrics.distance_km, 0),
      travel_time_sec: combinedRoutes.reduce(
        (sum, route) => sum + route.metrics.travel_time_sec,
        0,
      ),
      work_time_sec: combinedRoutes.reduce((sum, route) => sum + route.metrics.work_time_sec, 0),
      waiting_time_sec: combinedRoutes.reduce(
        (sum, route) => sum + route.metrics.waiting_time_sec,
        0,
      ),
      lunch_time_sec: combinedRoutes.reduce((sum, route) => sum + route.metrics.lunch_time_sec, 0),
    };
    const main: RouterPlan = planSchema.parse({
      ...result.main,
      routes: combinedRoutes,
      assignments: combinedAssignments,
      summary,
    });
    return { applicable: { ...result, main }, factCheck: result };
  }

  private async conflictWithFacts(tx: Tx, result: RouterResult): Promise<string | null> {
    const assignedIds = (result.main?.assignments ?? [])
      .filter((item) => item.status === 'assigned')
      .map((item) => item.request_id);

    if (assignedIds.length > 0) {
      const untouchable = await tx.request.findMany({
        where: {
          id: { in: assignedIds },
          OR: [
            { startedAt: { not: null } },
            { lifecycle: { in: ['in_progress', 'completed', 'cancelled'] } },
          ],
        },
        select: { id: true, lifecycle: true },
      });
      if (untouchable.length > 0) {
        return (
          'The plan distributes work that has already started, finished or been cancelled: ' +
          untouchable.map((item) => `${item.id} (${item.lifecycle})`).join(', ')
        );
      }
    }

    // A second lunch for a day whose lunch is already used.
    const lunchEngineers = (result.main?.routes ?? [])
      .filter((route) => route.lunch.status === 'scheduled')
      .map((route) => route.engineer_id);
    if (lunchEngineers.length > 0) {
      const used = await tx.engineerDay.findMany({
        where: { engineerId: { in: lunchEngineers }, lunchTaken: true },
        select: { engineerId: true },
      });
      if (used.length > 0) {
        return `The plan schedules a second lunch for ${used.map((day) => day.engineerId).join(', ')}`;
      }
    }

    return null;
  }

  /** Reuses automatic-acceptance fact guards for an immutable stored revision. */
  async conflictWithStoredPlanFacts(tx: Tx, plan: AppliedPlanCurrentShape): Promise<string | null> {
    // Unassigned work can have started under the newer plan; it must not disappear.
    const requestIds = plan.assignments.map((item) => item.requestId);
    if (requestIds.length > 0) {
      const untouchable = await tx.request.findMany({
        where: {
          id: { in: requestIds },
          OR: [
            { startedAt: { not: null } },
            { lifecycle: { in: ['in_progress', 'completed', 'cancelled'] } },
          ],
        },
        select: { id: true, lifecycle: true },
      });
      if (untouchable.length > 0) {
        return `The plan distributes work that has already started, finished or been cancelled: ${untouchable.map((item) => `${item.id} (${item.lifecycle})`).join(', ')}`;
      }
    }
    const lunchEngineers = plan.routes
      .filter((route) => route.lunchStatus === 'scheduled')
      .map((route) => route.engineerId);
    if (lunchEngineers.length > 0) {
      const used = await tx.engineerDay.findMany({
        where: { engineerId: { in: lunchEngineers }, lunchTaken: true },
        select: { engineerId: true },
      });
      if (used.length > 0)
        return `The plan schedules a second lunch for ${used.map((day) => day.engineerId).join(', ')}`;
    }
    return null;
  }

  private async reject(
    tx: Tx,
    result: RouterResult,
    reason: string,
    detail: string,
  ): Promise<AcceptanceOutcome> {
    await this.storePackage(tx, result, false, reason);
    return { accepted: false, reason, detail, resultId: result.result_id };
  }

  /** Keeps the package even when it was refused, so the refusal can be explained later. */
  private async storePackage(
    tx: Tx,
    result: RouterResult,
    accepted: boolean,
    rejectionCode: string | null,
  ) {
    const resultId = result.result_id ?? `unidentified-${this.clock.nowSeconds()}`;
    return tx.routerResult.upsert({
      where: { resultId },
      update: { accepted, rejectionCode, receivedAt: BigInt(this.clock.nowSeconds()) },
      create: {
        resultId,
        inputHash: result.input_hash ?? '',
        routerContextVersion: result.router_context_version ?? '',
        status: result.status,
        planningAsOf: result.planning_as_of === null ? null : BigInt(result.planning_as_of),
        computedAt: result.computed_at === null ? null : BigInt(result.computed_at),
        receivedAt: BigInt(this.clock.nowSeconds()),
        accepted,
        rejectionCode,
        payload: result as object,
      },
    });
  }

  private async recordPackage(result: RouterResult, accepted: boolean, rejectionCode: string) {
    await this.uow.run(async (tx) => {
      await this.storePackage(tx, result, accepted, rejectionCode);
    });
  }

  /**
   * One letter per business transition.
   *
   * The key is the request and the engineer, so a new result that repeats the same
   * assignment is not a new reason to write to the customer (context/36 section 10).
   */
  private async recordAssignmentNotifications(tx: Tx, result: RouterResult): Promise<void> {
    const now = this.clock.nowSeconds();
    for (const item of result.main?.assignments ?? []) {
      if (item.status !== 'assigned' || !item.engineer_id) {
        continue;
      }
      const request = await tx.request.findUnique({ where: { id: item.request_id } });
      if (!request) {
        continue;
      }
      await this.notifications.record(tx, now, {
        category: 'engineer_assigned',
        businessEventKey: `engineer_assigned:${item.request_id}:${item.engineer_id}`,
        recipientAccountId: request.clientAccountId,
        payload: { requestId: item.request_id, engineerId: item.engineer_id },
      });
    }
  }

  /** The last package received, applied or not, for the dispatcher's diagnostics. */
  async lastPackage() {
    return this.prisma.routerResult.findFirst({ orderBy: { receivedAt: 'desc' } });
  }
}
