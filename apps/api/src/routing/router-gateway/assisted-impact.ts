import { z } from 'zod';
import { canonicalHash } from '../../common/json';
import type { DispatcherSnapshotFacts } from '../dispatcher-constraints';
import type { RouterPlan } from './result.types';

/** Fixed product thresholds; units are business seconds and affected work orders. */
export const ASSISTED_IMPACT_LIMITS = {
  massChangeJobs: 3,
  significantDelaySec: 30 * 60,
  delayApprovalBucketSec: 15 * 60,
  windowApprovalBucketSec: 5 * 60,
} as const;

/** Minimal immutable applied-plan view required for a factual before/after comparison. */
export interface WorkingPlanForImpact {
  origin: string;
  routes: ReadonlyArray<{
    engineerId: string;
    stops: ReadonlyArray<{
      kind: string;
      requestId: string | null;
      startAt: bigint | number;
      endAt: bigint | number;
    }>;
  }>;
  assignments: ReadonlyArray<{ requestId: string; engineerId: string | null; status: string }>;
}

export interface AssistedImpact {
  assignedBefore: number;
  assignedAfter: number;
  lost: Array<{ requestId: string; engineerId: string; priority: string }>;
  moved: Array<{ requestId: string; fromEngineerId: string; toEngineerId: string }>;
  reorderedRoutes: Array<{
    engineerId: string;
    beforeRequestIds: string[];
    afterRequestIds: string[];
    changedRequestIds: string[];
  }>;
  delayed: Array<{
    requestId: string;
    beforeStartAt: number;
    afterStartAt: number;
    delaySec: number;
  }>;
  newlyLate: Array<{ requestId: string; endAt: number; windowEndAt: number; latenessSec: number }>;
  addedEngineerIds: string[];
  timingsCompared: boolean;
  criticalReasons: Array<{ code: string; entityIds: string[] }>;
  requiresConfirmation: boolean;
  fingerprint: string;
}

/** Recheck durable proposal evidence before trusting it during confirmation. */
export const assistedImpactSchema: z.ZodType<AssistedImpact> = z.object({
  assignedBefore: z.number().int().nonnegative(),
  assignedAfter: z.number().int().nonnegative(),
  lost: z.array(z.object({ requestId: z.string(), engineerId: z.string(), priority: z.string() })),
  moved: z.array(
    z.object({ requestId: z.string(), fromEngineerId: z.string(), toEngineerId: z.string() }),
  ),
  reorderedRoutes: z.array(
    z.object({
      engineerId: z.string(),
      beforeRequestIds: z.array(z.string()),
      afterRequestIds: z.array(z.string()),
      changedRequestIds: z.array(z.string()),
    }),
  ),
  delayed: z.array(
    z.object({
      requestId: z.string(),
      beforeStartAt: z.number(),
      afterStartAt: z.number(),
      delaySec: z.number(),
    }),
  ),
  newlyLate: z.array(
    z.object({
      requestId: z.string(),
      endAt: z.number(),
      windowEndAt: z.number(),
      latenessSec: z.number(),
    }),
  ),
  addedEngineerIds: z.array(z.string()),
  timingsCompared: z.boolean(),
  criticalReasons: z.array(z.object({ code: z.string(), entityIds: z.array(z.string()) })),
  requiresConfirmation: z.boolean(),
  fingerprint: z.string(),
});

/** Compare only remaining work; completed visits and unverified manual ETA are not losses. */
export function compareAssistedImpact(
  before: WorkingPlanForImpact | null,
  after: RouterPlan,
  snapshot: DispatcherSnapshotFacts,
): AssistedImpact {
  const remaining = new Map(snapshot.requests.map((request) => [request.request_id, request]));
  const previous = new Map(
    (before?.assignments ?? []).flatMap((row) =>
      row.status === 'assigned' && row.engineerId && remaining.has(row.requestId)
        ? [[row.requestId, row.engineerId] as const]
        : [],
    ),
  );
  const next = new Map(
    after.assignments.flatMap((row) =>
      row.status === 'assigned' && row.engineer_id
        ? [[row.request_id, row.engineer_id] as const]
        : [],
    ),
  );
  const lost: AssistedImpact['lost'] = [];
  const moved: AssistedImpact['moved'] = [];
  for (const [requestId, engineerId] of previous) {
    const nextOwner = next.get(requestId);
    if (!nextOwner)
      lost.push({
        requestId,
        engineerId,
        priority: remaining.get(requestId)?.priority ?? 'normal',
      });
    else if (nextOwner !== engineerId)
      moved.push({ requestId, fromEngineerId: engineerId, toEngineerId: nextOwner });
  }
  const reorderedRoutes: AssistedImpact['reorderedRoutes'] = [];
  for (const route of before?.routes ?? []) {
    const nextOrder =
      after.routes
        .find((row) => row.engineer_id === route.engineerId)
        ?.stops.filter((stop) => stop.kind === 'job' && stop.request_id)
        .map((stop) => stop.request_id) ?? [];
    const retained = route.stops.flatMap((stop) =>
      stop.kind === 'job' &&
      stop.requestId &&
      remaining.has(stop.requestId) &&
      next.get(stop.requestId) === route.engineerId
        ? [stop.requestId]
        : [],
    );
    const changed = new Set<string>();
    for (let first = 0; first < retained.length; first++) {
      for (let second = first + 1; second < retained.length; second++) {
        const a = retained[first];
        const b = retained[second];
        if (a && b && nextOrder.indexOf(a) > nextOrder.indexOf(b)) {
          changed.add(a);
          changed.add(b);
        }
      }
    }
    if (changed.size)
      reorderedRoutes.push({
        engineerId: route.engineerId,
        beforeRequestIds: retained,
        afterRequestIds: nextOrder.flatMap((id) => (id && retained.includes(id) ? [id] : [])),
        changedRequestIds: [...changed].sort(),
      });
  }
  const timingsCompared = before !== null && before.origin !== 'manual';
  const oldStops = new Map(
    (before?.routes ?? [])
      .flatMap((route) => route.stops)
      .flatMap((stop) =>
        stop.kind === 'job' && stop.requestId ? [[stop.requestId, stop] as const] : [],
      ),
  );
  const delayed: AssistedImpact['delayed'] = [];
  const newlyLate: AssistedImpact['newlyLate'] = [];
  if (timingsCompared) {
    for (const route of after.routes) {
      for (const stop of route.stops) {
        if (stop.kind !== 'job' || !stop.request_id) continue;
        const old = oldStops.get(stop.request_id);
        const request = remaining.get(stop.request_id);
        if (!old || !request) continue;
        const delaySec = stop.start_at - Number(old.startAt);
        if (delaySec > 0)
          delayed.push({
            requestId: stop.request_id,
            beforeStartAt: Number(old.startAt),
            afterStartAt: stop.start_at,
            delaySec,
          });
        if (Number(old.endAt) <= request.window_end_at && stop.end_at > request.window_end_at) {
          newlyLate.push({
            requestId: stop.request_id,
            endAt: stop.end_at,
            windowEndAt: request.window_end_at,
            latenessSec: stop.end_at - request.window_end_at,
          });
        }
      }
    }
  }
  const previousCrews = new Set(previous.values());
  const addedEngineerIds = [
    ...new Set(
      after.routes
        .filter(
          (route) =>
            route.engineer_id.startsWith('covering-') &&
            route.metrics.assigned_count > 0 &&
            !previousCrews.has(route.engineer_id),
        )
        .map((route) => route.engineer_id),
    ),
  ].sort();
  const criticalReasons: AssistedImpact['criticalReasons'] = [];
  const reorderedIds = [
    ...new Set(reorderedRoutes.flatMap((route) => route.changedRequestIds)),
  ].sort();
  if (lost.length)
    criticalReasons.push({
      code: 'ASSIGNMENTS_LOST',
      entityIds: lost.map((row) => row.requestId).sort(),
    });
  if (moved.length >= ASSISTED_IMPACT_LIMITS.massChangeJobs)
    criticalReasons.push({
      code: 'MASS_REASSIGNMENT',
      entityIds: moved.map((row) => row.requestId).sort(),
    });
  if (reorderedIds.length >= ASSISTED_IMPACT_LIMITS.massChangeJobs)
    criticalReasons.push({ code: 'MASS_REORDER', entityIds: reorderedIds });
  const delayedIds = delayed
    .filter((row) => row.delaySec >= ASSISTED_IMPACT_LIMITS.significantDelaySec)
    .map((row) => row.requestId)
    .sort();
  if (delayedIds.length) criticalReasons.push({ code: 'SIGNIFICANT_DELAY', entityIds: delayedIds });
  if (newlyLate.length)
    criticalReasons.push({
      code: 'NEW_WINDOW_VIOLATION',
      entityIds: newlyLate.map((row) => row.requestId).sort(),
    });
  if (addedEngineerIds.length)
    criticalReasons.push({ code: 'ADDITIONAL_ENGINEERS', entityIds: addedEngineerIds });
  const impact = {
    assignedBefore: previous.size,
    assignedAfter: next.size,
    lost,
    moved,
    reorderedRoutes,
    delayed,
    newlyLate,
    addedEngineerIds,
    timingsCompared,
    criticalReasons,
    requiresConfirmation: criticalReasons.length > 0,
  };
  return { ...impact, fingerprint: canonicalHash(impact) };
}

/** A refreshed candidate may improve an approval, but cannot introduce a new serious harm. */
export function criticalImpactCovered(approved: AssistedImpact, current: AssistedImpact): boolean {
  for (const reason of current.criticalReasons) {
    const previous = approved.criticalReasons.find((row) => row.code === reason.code);
    if (!previous || reason.entityIds.some((id) => !previous.entityIds.includes(id))) return false;
  }
  if (
    current.criticalReasons.some((row) => row.code === 'MASS_REASSIGNMENT') &&
    current.moved.some(
      (row) =>
        !approved.moved.some(
          (old) => old.requestId === row.requestId && old.toEngineerId === row.toEngineerId,
        ),
    )
  )
    return false;
  if (
    current.criticalReasons.some((row) => row.code === 'MASS_REORDER') &&
    current.reorderedRoutes.some((row) => {
      const previous = approved.reorderedRoutes.find((old) => old.engineerId === row.engineerId);
      return (
        !previous ||
        JSON.stringify(row.afterRequestIds) !==
          JSON.stringify(previous.afterRequestIds.filter((id) => row.afterRequestIds.includes(id)))
      );
    })
  )
    return false;
  for (const row of current.delayed.filter(
    (item) => item.delaySec >= ASSISTED_IMPACT_LIMITS.significantDelaySec,
  )) {
    const old = approved.delayed.find((item) => item.requestId === row.requestId);
    if (
      !old ||
      Math.ceil(row.delaySec / ASSISTED_IMPACT_LIMITS.delayApprovalBucketSec) >
        Math.ceil(old.delaySec / ASSISTED_IMPACT_LIMITS.delayApprovalBucketSec)
    )
      return false;
  }
  for (const row of current.newlyLate) {
    const old = approved.newlyLate.find((item) => item.requestId === row.requestId);
    if (
      !old ||
      Math.ceil(row.latenessSec / ASSISTED_IMPACT_LIMITS.windowApprovalBucketSec) >
        Math.ceil(old.latenessSec / ASSISTED_IMPACT_LIMITS.windowApprovalBucketSec)
    )
      return false;
  }
  return true;
}

/** Bind a user's acknowledgement to the exact review card, not just its mutable ID. */
export function assistedReviewFingerprint(
  inputHash: string,
  contextVersion: string,
  impact: AssistedImpact,
  modeVersion: number,
  planRevision: number,
  constraintsVersion: number,
): string {
  return canonicalHash({
    inputHash,
    contextVersion,
    impact: impact.fingerprint,
    modeVersion,
    planRevision,
    constraintsVersion,
  });
}
