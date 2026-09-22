import { describe, expect, it } from 'vitest';
import {
  CURRENT_PLAN,
  createDevSnapshot,
  FOCUS_REQUEST_ID,
  REBUILT_PLAN,
} from '../fixtures/dev-day';
import {
  computePlanDelta,
  engineerSummaries,
  equipmentLoadout,
  isExpectedRebuildApplied,
  plannedActivity,
  planWithLunches,
  reconcileDashboardFocus,
  regionalDistanceKm,
  remainingRouteForLiveMap,
  requestById,
  routeVertices,
  unassignedRequests,
  withLunches,
} from './dashboard';

describe('dev dashboard fixture', () => {
  it('counts pending current-day work without claiming it is assigned and excludes tomorrow', () => {
    const snapshot = createDevSnapshot();
    const request = snapshot.requests[0];
    if (!request) throw new Error('request fixture missing');
    const start = Date.parse(`${snapshot.workDate}T09:00:00+03:00`) / 1000;
    const pending = {
      ...request,
      assignmentState: 'pending' as const,
      lifecycle: 'submitted' as const,
      windowStartAt: start,
      windowEndAt: start + 3600,
    };
    expect(unassignedRequests({ ...snapshot, requests: [pending] })).toEqual([pending]);
    expect(
      unassignedRequests({
        ...snapshot,
        requests: [{ ...pending, windowStartAt: start + 86400, windowEndAt: start + 90000 }],
      }),
    ).toEqual([]);
  });
  it('keeps two skill-blocked requests unassigned', () => {
    const snapshot = createDevSnapshot();
    const unassigned = unassignedRequests(snapshot);
    expect(unassigned.map((item) => item.id)).toEqual(['10490', '10491']);
    expect(snapshot.requests).toHaveLength(24);
  });

  it('keeps completed, cancelled and silently assumed jobs in history but removes them from live map edges', () => {
    const snapshot = createDevSnapshot();
    const route = snapshot.plan.plan?.routes[0];
    const [completedId, cancelledId, assumedId] =
      route?.stops.flatMap((stop) => (stop.requestId ? [stop.requestId] : [])).slice(0, 3) ?? [];
    if (!route || !completedId || !cancelledId || !assumedId) {
      throw new Error('fixture route needs three jobs');
    }
    const updated = {
      ...snapshot,
      requests: snapshot.requests.map((request) =>
        request.id === completedId
          ? { ...request, lifecycle: 'completed' as const }
          : request.id === cancelledId
            ? { ...request, lifecycle: 'cancelled' as const }
            : request.id === assumedId
              ? { ...request, assumedCompletedAt: 1_800_000_000 }
              : request,
      ),
    };

    const mapRoute = remainingRouteForLiveMap(updated, route);

    expect(mapRoute?.stops.map((stop) => stop.requestId)).not.toContain(completedId);
    expect(mapRoute?.stops.map((stop) => stop.requestId)).not.toContain(cancelledId);
    expect(mapRoute?.stops.map((stop) => stop.requestId)).not.toContain(assumedId);
    expect(mapRoute?.legs).toEqual([]);
    expect(route.stops.map((stop) => stop.requestId)).toContain(completedId);
  });

  it('summarizes Sokolov route from the applied plan', () => {
    const snapshot = createDevSnapshot();
    const route = snapshot.plan.plan?.routes[0];
    const conflicting = {
      ...snapshot,
      plan: {
        ...snapshot.plan,
        plan:
          snapshot.plan.plan && route
            ? {
                ...snapshot.plan.plan,
                routes: [{ ...route, assignedCount: 999 }, ...snapshot.plan.plan.routes.slice(1)],
              }
            : snapshot.plan.plan,
      },
    };
    const [sokolov] = engineerSummaries(conflicting);
    expect(sokolov?.engineerId).toBe('eng-sokolov');
    expect(sokolov?.assignedCount).toBe(6);
    expect(sokolov?.distanceKm).toBe(28);
    expect(regionalDistanceKm(engineerSummaries(snapshot))).toBeGreaterThan(0);
  });

  it('preserves Router wait stops and reports waiting as planned activity', () => {
    const base = createDevSnapshot();
    const route = base.plan.plan?.routes[0];
    expect(route).toBeTruthy();
    if (!route || !base.plan.plan) {
      return;
    }
    const wait = {
      sequence: 1,
      kind: 'wait' as const,
      requestId: null,
      lat: route.startLat,
      lon: route.startLon,
      arrivalAt: base.nowAt - 60,
      startAt: base.nowAt - 60,
      endAt: base.nowAt + 60,
    };
    const waitingRoute = { ...route, stops: [wait, ...route.stops] };
    const snapshot = {
      ...base,
      plan: {
        ...base.plan,
        plan: {
          ...base.plan.plan,
          routes: [waitingRoute, ...base.plan.plan.routes.slice(1)],
        },
      },
    };

    expect(routeVertices(waitingRoute)[1]?.kind).toBe('wait');
    expect(plannedActivity(snapshot, waitingRoute.engineerId)?.kind).toBe('waiting');
  });

  it('exposes structured reasons for the focused request', () => {
    const snapshot = createDevSnapshot();
    const request = requestById(snapshot, FOCUS_REQUEST_ID);
    const assignment = snapshot.plan.plan?.assignments.find(
      (item) => item.requestId === FOCUS_REQUEST_ID,
    );
    expect(request?.addressText).toContain('Таганская');
    expect(assignment?.engineerId).toBe('eng-sokolov');
    expect(assignment?.reasons.assignment?.factors[0]?.code).toBe('skill_match');
  });

  it('starts every route at a named depot, not at the first job', () => {
    const snapshot = createDevSnapshot();
    const route = snapshot.plan.plan?.routes[0];
    expect(route).toBeTruthy();
    if (!route) {
      return;
    }
    const [start, firstJob] = routeVertices(route);
    expect(start?.kind).toBe('start');
    expect(start?.lat).toBe(route.startLat);
    expect(firstJob?.kind).toBe('job');
  });

  it('reads planned activity at 11:42 without inventing GPS', () => {
    const snapshot = createDevSnapshot();
    const traveling = plannedActivity(snapshot, 'eng-sokolov');
    expect(traveling?.kind).toBe('traveling');
    expect(traveling?.lat).toBeNull();
    expect(traveling?.lon).toBeNull();
    expect(traveling?.legIndex).toBeTypeOf('number');
    expect(plannedActivity(snapshot, 'eng-volkova')?.kind).toBe('on_site');
    expect(snapshot.lunchesEnabled).toBe(false);
    expect(plannedActivity(snapshot, 'eng-petrov')?.kind).toBe('traveling');
  });

  it('places Petrov lunch only after the dashboard switch is on', () => {
    const off = createDevSnapshot();
    expect(off.engineers.every((item) => item.day?.lunch.enabled === false)).toBe(true);
    expect(off.plan.plan?.routes.some((route) => route.lunchStatus !== 'none')).toBe(false);

    const on = withLunches(
      { ...off, plan: { ...off.plan, plan: planWithLunches(CURRENT_PLAN, true) } },
      true,
    );
    expect(on.lunchesEnabled).toBe(true);
    expect(on.engineers.every((item) => item.day?.lunch.enabled === true)).toBe(true);
    expect(plannedActivity(on, 'eng-petrov')?.kind).toBe('lunch');
  });

  it('computes a readable replan delta between fixture plans', () => {
    const delta = computePlanDelta(CURRENT_PLAN, REBUILT_PLAN, 1180);
    expect(delta.transferred).toBeGreaterThan(0);
    expect(delta.shifted).toBeGreaterThan(0);
    expect(delta.slaBefore).toBe(2);
    expect(delta.slaAfter).toBe(2);
    expect(delta.solveMs).toBe(1180);
  });

  it('accepts a rebuild only after a newer plan and accepted Router result', () => {
    const base = createDevSnapshot();
    const revision = base.plan.plan?.revision ?? 0;
    const expected = {
      previousRevision: revision,
      previousResultId: 'previous-result',
      policyId: base.policyId,
      lunchesEnabled: base.lunchesEnabled,
      inputHash: 'target-input',
      routerContextVersion: 'target-context',
    } as const;
    const rejected = {
      ...base,
      plan: {
        ...base.plan,
        plan: base.plan.plan ? { ...base.plan.plan, revision: revision + 1 } : null,
        lastResult: {
          resultId: 'rejected-result',
          inputHash: 'target-input',
          routerContextVersion: 'target-context',
          accepted: false,
          rejectionCode: 'STALE_PUBLICATION',
          receivedAt: base.nowAt + 1,
        },
      },
    };
    expect(isExpectedRebuildApplied(rejected, expected)).toBe(false);

    const acceptedWithoutRevision = {
      ...base,
      plan: {
        ...base.plan,
        appliedResult: {
          resultId: 'accepted-result',
          inputHash: 'target-input',
          routerContextVersion: 'target-context',
        },
        lastResult: {
          resultId: 'accepted-result',
          inputHash: 'target-input',
          routerContextVersion: 'target-context',
          accepted: true,
          rejectionCode: null,
          receivedAt: base.nowAt + 1,
        },
      },
    };
    expect(isExpectedRebuildApplied(acceptedWithoutRevision, expected)).toBe(false);

    const unrelated = {
      ...acceptedWithoutRevision,
      plan: {
        ...acceptedWithoutRevision.plan,
        plan: base.plan.plan ? { ...base.plan.plan, revision: revision + 1 } : null,
        appliedResult: {
          ...acceptedWithoutRevision.plan.appliedResult,
          inputHash: 'unrelated-input',
        },
      },
    };
    expect(isExpectedRebuildApplied(unrelated, expected)).toBe(false);

    const accepted = {
      ...acceptedWithoutRevision,
      plan: {
        ...acceptedWithoutRevision.plan,
        plan: base.plan.plan ? { ...base.plan.plan, revision: revision + 1 } : null,
      },
    };
    expect(isExpectedRebuildApplied(accepted, expected)).toBe(true);
  });

  it('keeps explicit general view after a refreshed snapshot', () => {
    const snapshot = createDevSnapshot();
    expect(reconcileDashboardFocus(snapshot, { engineerId: null, requestId: null })).toEqual({
      engineerId: null,
      requestId: null,
    });
  });

  it('calculates morning equipment demand and remaining spare stock', () => {
    const snapshot = createDevSnapshot();
    const lines = equipmentLoadout(snapshot, 'eng-sokolov');
    const router = lines.find((line) => line.type === 'router');
    expect(router?.stock).toBe(3);
    expect(router?.spare).toBe(Math.max(0, 3 - (router?.demand ?? 0)));
    expect(lines).toHaveLength(3);
  });
});
