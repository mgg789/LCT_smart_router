import type {
  DashboardSnapshot,
  EquipmentStock,
  EquipmentType,
  PlanAssignmentView,
  PlanDelta,
  PlanRouteView,
  PlanView,
  PolicyId,
  RequestView,
} from '../api/types';
import { t } from '../i18n';

export interface DashboardFocus {
  readonly engineerId: string | null;
  readonly requestId: string | null;
}

export interface EquipmentLoadLine {
  readonly type: EquipmentType;
  readonly stock: number;
  readonly demand: number;
  readonly spare: number;
  readonly shortage: number;
}

export interface RebuildExpectation {
  readonly previousRevision: number | null;
  readonly previousResultId: string | null;
  readonly policyId: PolicyId;
  readonly lunchesEnabled: boolean;
  readonly inputHash: string | null;
  readonly routerContextVersion: string;
}

/** Proves that System Layer accepted and applied the Router result requested by the UI. */
export function isExpectedRebuildApplied(
  snapshot: DashboardSnapshot,
  expected: RebuildExpectation,
): boolean {
  const appliedResult = snapshot.plan.appliedResult;
  const revision = snapshot.plan.plan?.revision ?? null;
  const newerRevision =
    revision !== null &&
    (expected.previousRevision === null || revision > expected.previousRevision);
  return (
    newerRevision &&
    appliedResult !== null &&
    appliedResult.resultId !== expected.previousResultId &&
    (expected.inputHash === null || appliedResult.inputHash === expected.inputHash) &&
    appliedResult.routerContextVersion === expected.routerContextVersion &&
    snapshot.policyId === expected.policyId &&
    snapshot.lunchesEnabled === expected.lunchesEnabled
  );
}

export interface EngineerSummary {
  readonly engineerId: string;
  readonly displayName: string;
  readonly skills: string[];
  readonly transportType: string;
  readonly availability: string;
  readonly shiftStartAt: number | null;
  readonly shiftEndAt: number | null;
  readonly distanceKm: number;
  readonly assignedCount: number;
  readonly doneCount: number;
  readonly inProgressCount: number;
}

export function requestById(snapshot: DashboardSnapshot, requestId: string): RequestView | null {
  return snapshot.requests.find((item) => item.id === requestId) ?? null;
}

export function assignmentFor(
  snapshot: DashboardSnapshot,
  requestId: string,
): PlanAssignmentView | null {
  return snapshot.plan.plan?.assignments.find((item) => item.requestId === requestId) ?? null;
}

export function routeForEngineer(
  snapshot: DashboardSnapshot,
  engineerId: string,
): PlanRouteView | null {
  return snapshot.plan.plan?.routes.find((route) => route.engineerId === engineerId) ?? null;
}

/** The requests this working day is about: everything whose window touches it. */
export function dayRequests(snapshot: DashboardSnapshot): RequestView[] {
  const dayStart = Date.parse(`${snapshot.workDate}T00:00:00+03:00`) / 1000;
  return snapshot.requests.filter(
    (item) => item.windowStartAt < dayStart + 86400 && item.windowEndAt >= dayStart,
  );
}

export function unassignedRequests(snapshot: DashboardSnapshot): RequestView[] {
  return dayRequests(snapshot).filter(
    (item) => item.lifecycle === 'submitted' && item.assignmentState !== 'assigned',
  );
}

/**
 * The requests the arrows in the open request card page through, in the order the card
 * itself is read in.
 *
 * An assigned request belongs to one engineer's day, so its neighbours are that route's
 * other stops in visiting order -- paging through them walks the day. An unassigned one
 * has no route, so its neighbours are the rest of the day's unassigned pile, in the order
 * the board lists it. The two sets never mix: stepping off the end of a route onto
 * somebody else's stop would silently change which engineer the dispatcher is looking at.
 *
 * Returns an empty list when the request is not on this day at all, which leaves the
 * arrows with nothing to offer.
 */
export function requestNeighbours(
  snapshot: DashboardSnapshot,
  requestId: string,
): { readonly scope: 'route' | 'unassigned'; readonly ids: readonly string[] } {
  const assignment = assignmentFor(snapshot, requestId);
  if (assignment?.engineerId) {
    const route = routeForEngineer(snapshot, assignment.engineerId);
    const stops = [...(route?.stops ?? [])]
      .sort((a, b) => a.sequence - b.sequence)
      .map((stop) => stop.requestId)
      .filter((id): id is string => id !== null);
    // A route may visit the same request twice (a handoff leg); the card is one per
    // request, so the list holds each one once, at its first visit.
    return { scope: 'route', ids: [...new Set(stops)] };
  }
  const pile = unassignedRequests(snapshot).map((item) => item.id);
  return { scope: 'unassigned', ids: pile.includes(requestId) ? pile : [] };
}

/** The neighbour `step` places along, or null at either end -- the arrows never wrap. */
export function neighbourAt(
  neighbours: readonly string[],
  requestId: string,
  step: 1 | -1,
): string | null {
  const at = neighbours.indexOf(requestId);
  if (at < 0) return null;
  return neighbours[at + step] ?? null;
}

/** Sum planned mileage of the engineers currently shown for the selected region. */
export function regionalDistanceKm(engineers: readonly EngineerSummary[]): number {
  return engineers.reduce((sum, item) => sum + item.distanceKm, 0);
}

export function engineerSummaries(snapshot: DashboardSnapshot): EngineerSummary[] {
  return snapshot.engineers.map((engineer) => {
    const route = routeForEngineer(snapshot, engineer.id);
    const assignments =
      snapshot.plan.plan?.assignments.filter(
        (assignment) => assignment.engineerId === engineer.id && assignment.status !== 'unassigned',
      ) ?? [];
    const requestIds = assignments.map((assignment) => assignment.requestId);
    const doneCount = requestIds.filter((id) => {
      const request = requestById(snapshot, id);
      return request?.lifecycle === 'completed' || request?.assignmentState === 'done';
    }).length;
    const inProgressCount = requestIds.filter((id) => {
      const request = requestById(snapshot, id);
      return request?.lifecycle === 'in_progress';
    }).length;
    return {
      engineerId: engineer.id,
      displayName: engineer.displayName,
      skills: engineer.skills,
      transportType: engineer.transportType,
      availability: engineer.day?.availability ?? 'offline',
      shiftStartAt: engineer.day?.shiftStartAt ?? null,
      shiftEndAt: engineer.day?.shiftEndAt ?? null,
      distanceKm: route?.distanceKm ?? 0,
      assignedCount: assignments.length,
      doneCount,
      inProgressCount,
    };
  });
}

/** Preserves explicit general view across polling and only removes selections that disappeared. */
export function reconcileDashboardFocus(
  snapshot: DashboardSnapshot,
  focus: DashboardFocus,
): DashboardFocus {
  return {
    engineerId: snapshot.engineers.some((item) => item.id === focus.engineerId)
      ? focus.engineerId
      : null,
    requestId: snapshot.requests.some((item) => item.id === focus.requestId)
      ? focus.requestId
      : null,
  };
}

/** Calculates planned demand against the equipment issued to one engineer for the day. */
export function equipmentLoadout(
  snapshot: DashboardSnapshot,
  engineerId: string,
): EquipmentLoadLine[] {
  const engineer = snapshot.engineers.find((item) => item.id === engineerId);
  const stock: EquipmentStock = engineer?.day?.equipmentStock ?? {
    router: 0,
    setTopBox: 0,
    smartSpeaker: 0,
  };
  const requestByAssignment = new Map(snapshot.requests.map((request) => [request.id, request]));
  const demand = { router: 0, set_top_box: 0, smart_speaker: 0 };
  for (const assignment of snapshot.plan.plan?.assignments ?? []) {
    if (assignment.engineerId !== engineerId || assignment.status === 'unassigned') {
      continue;
    }
    const equipment = requestByAssignment.get(assignment.requestId)?.requiredEquipment;
    if (equipment) {
      demand[equipment] += 1;
    }
  }
  return [
    equipmentLine('router', stock.router, demand.router),
    equipmentLine('set_top_box', stock.setTopBox, demand.set_top_box),
    equipmentLine('smart_speaker', stock.smartSpeaker, demand.smart_speaker),
  ];
}

function equipmentLine(type: EquipmentType, stock: number, demand: number): EquipmentLoadLine {
  return {
    type,
    stock,
    demand,
    spare: Math.max(0, stock - demand),
    shortage: Math.max(0, demand - stock),
  };
}

export function currentStopId(snapshot: DashboardSnapshot, engineerId: string): string | null {
  const activity = plannedActivity(snapshot, engineerId);
  if (activity?.requestId) {
    return activity.requestId;
  }
  const route = routeForEngineer(snapshot, engineerId);
  return (
    route?.stops.find((stop) => snapshot.nowAt < stop.startAt && stop.requestId)?.requestId ?? null
  );
}

export type ActivityKind =
  | 'not_started'
  | 'traveling'
  | 'waiting'
  | 'on_site'
  | 'lunch'
  | 'finished';

export interface RouteVertex {
  readonly kind: 'start' | 'job' | 'lunch' | 'wait' | 'handoff' | 'delivery' | 'office_pickup';
  readonly lat: number;
  readonly lon: number;
  readonly startAt: number;
  readonly endAt: number;
  readonly requestId: string | null;
  readonly handoffId?: string | null;
  readonly sequence: number;
}

export interface RouteLegView {
  readonly index: number;
  readonly from: RouteVertex;
  readonly to: RouteVertex;
  readonly departAt: number;
  readonly arriveAt: number;
}

export interface EngineerActivity {
  readonly kind: ActivityKind;
  readonly engineerId: string;
  readonly requestId: string | null;
  readonly legIndex: number | null;
  /** Known vertex only. Travel has no point: we know the edge, not a GPS fix. */
  readonly lat: number | null;
  readonly lon: number | null;
  readonly label: string;
}

export function routeVertices(route: PlanRouteView): RouteVertex[] {
  const startAt = route.startAt ?? route.stops[0]?.arrivalAt ?? 0;
  const start: RouteVertex = {
    kind: 'start',
    lat: route.startLat,
    lon: route.startLon,
    startAt,
    endAt: startAt,
    requestId: null,
    sequence: 0,
  };
  const rest = route.stops.map((stop) => ({
    kind: stop.kind === 'start' ? ('job' as const) : stop.kind,
    lat: stop.lat,
    lon: stop.lon,
    startAt: stop.startAt,
    endAt: stop.endAt,
    requestId: stop.requestId,
    handoffId: stop.handoff?.handoff_id ?? null,
    sequence: stop.sequence,
  }));
  return [start, ...rest];
}

export function routeLegs(route: PlanRouteView): RouteLegView[] {
  const vertices = routeVertices(route);
  const legs: RouteLegView[] = [];
  for (let index = 0; index < vertices.length - 1; index += 1) {
    const from = vertices[index];
    const to = vertices[index + 1];
    if (!from || !to) {
      continue;
    }
    legs.push({
      index,
      from,
      to,
      departAt: from.endAt,
      arriveAt: to.startAt,
    });
  }
  return legs;
}

export function plannedActivity(
  snapshot: DashboardSnapshot,
  engineerId: string,
): EngineerActivity | null {
  const route = routeForEngineer(snapshot, engineerId);
  if (!route) {
    return null;
  }
  const now = snapshot.nowAt;
  const vertices = routeVertices(route);
  const start = vertices[0];
  const last = vertices[vertices.length - 1];
  if (!start || !last) {
    return null;
  }

  for (const vertex of vertices) {
    if (vertex.kind === 'start') {
      continue;
    }
    if (now >= vertex.startAt && now < vertex.endAt) {
      if (vertex.kind === 'lunch') {
        return {
          kind: 'lunch',
          engineerId,
          requestId: null,
          legIndex: null,
          lat: vertex.lat,
          lon: vertex.lon,
          label: t('domain.dashboard.540fbf5cdb'),
        };
      }
      if (vertex.kind === 'wait') {
        return {
          kind: 'waiting',
          engineerId,
          requestId: null,
          legIndex: null,
          lat: vertex.lat,
          lon: vertex.lon,
          label: t('domain.dashboard.777412e89b'),
        };
      }
      return {
        kind: 'on_site',
        engineerId,
        requestId: vertex.requestId,
        legIndex: null,
        lat: vertex.lat,
        lon: vertex.lon,
        label: t('domain.dashboard.fe05f1d13a'),
      };
    }
  }

  for (const leg of routeLegs(route)) {
    if (now >= leg.departAt && now < leg.arriveAt) {
      return {
        kind: 'traveling',
        engineerId,
        requestId: leg.to.requestId,
        legIndex: leg.index,
        lat: null,
        lon: null,
        label: t('domain.dashboard.7c9cecb806'),
      };
    }
  }

  if (now < start.startAt) {
    return {
      kind: 'not_started',
      engineerId,
      requestId: null,
      legIndex: null,
      lat: start.lat,
      lon: start.lon,
      label: t('domain.dashboard.ad77e66b6d'),
    };
  }

  return {
    kind: 'finished',
    engineerId,
    requestId: last.requestId,
    legIndex: null,
    lat: last.lat,
    lon: last.lon,
    label: t('domain.dashboard.3ee8a6a84e'),
  };
}

export function activityLabel(kind: ActivityKind): string {
  if (kind === 'traveling') {
    return t('domain.dashboard.7376f1d753');
  }
  if (kind === 'on_site') {
    return t('domain.dashboard.2bc104c54f');
  }
  if (kind === 'lunch') {
    return t('domain.dashboard.c0f7d29eab');
  }
  if (kind === 'waiting') {
    return t('domain.dashboard.865fcaf5f9');
  }
  if (kind === 'finished') {
    return t('domain.dashboard.5e2d2bfb4d');
  }
  return t('domain.dashboard.c720a2dc46');
}

const WINDOW_SHIFT_SEC = 5 * 60;

/**
 * Short comparison of two applied plans.
 *
 * `engineerNames` turns ids into the names shown on the lunch line and on a handoff.
 * A missing name falls back to the first eight characters of the id.
 */
export function computePlanDelta(
  before: PlanView,
  after: PlanView,
  solveMs: number,
  engineerNames: ReadonlyMap<string, string> = new Map(),
): PlanDelta {
  const beforeByRequest = new Map(before.assignments.map((item) => [item.requestId, item]));
  let transferred = 0;
  let shifted = 0;
  const lines: PlanDelta['lines'] = [];

  for (const next of after.assignments) {
    const prev = beforeByRequest.get(next.requestId);
    if (!prev) {
      lines.push({
        requestId: next.requestId,
        engineerName: null,
        text: t('domain.dashboard.ee5790e7f4'),
      });
      continue;
    }
    if (prev.engineerId !== next.engineerId) {
      transferred += 1;
      lines.push({
        requestId: next.requestId,
        engineerName: null,
        text:
          next.engineerId === null
            ? t('domain.dashboard.ae6bef78e3')
            : `${crewName(prev.engineerId, engineerNames)} → ${crewName(next.engineerId, engineerNames)}`,
      });
    }
  }

  const beforeStops = new Map(
    before.routes.flatMap((route) =>
      route.stops
        .filter((stop) => stop.requestId)
        .map((stop) => [stop.requestId ?? '', stop.startAt] as const),
    ),
  );
  for (const route of after.routes) {
    for (const stop of route.stops) {
      if (!stop.requestId) {
        continue;
      }
      const previousStart = beforeStops.get(stop.requestId);
      if (
        previousStart !== undefined &&
        Math.abs(previousStart - stop.startAt) >= WINDOW_SHIFT_SEC
      ) {
        shifted += 1;
        lines.push({
          requestId: stop.requestId,
          engineerName: null,
          text: t('domain.dashboard.2001b87dfe', {
            value0: moscowClock(previousStart),
            value1: moscowClock(stop.startAt),
          }),
        });
      }
    }
  }

  const beforeLunch = lunchArrival(before);
  const afterLunch = lunchArrival(after);
  const engineerIds = new Set([...beforeLunch.keys(), ...afterLunch.keys()]);
  for (const engineerId of engineerIds) {
    const previousAt = beforeLunch.get(engineerId);
    const nextAt = afterLunch.get(engineerId);
    const moved =
      previousAt === undefined ||
      nextAt === undefined ||
      Math.abs(previousAt - nextAt) >= WINDOW_SHIFT_SEC;
    if (!moved) continue;
    lines.push({
      requestId: null,
      engineerName: crewName(engineerId, engineerNames),
      text: t('domain.dashboard.34d8132a67'),
    });
  }

  const slaBefore = countSlaRisks(before);
  const slaAfter = countSlaRisks(after);
  const beforeFacts = planFacts(before);
  const afterFacts = planFacts(after);
  return {
    transferred,
    shifted,
    slaBefore,
    slaAfter,
    solveMs,
    lines,
    assignedBefore: beforeFacts.assigned,
    assignedAfter: afterFacts.assigned,
    distanceBeforeKm: roundKm(beforeFacts.distance),
    distanceAfterKm: roundKm(afterFacts.distance),
    engineersBefore: beforeFacts.engineers,
    engineersAfter: afterFacts.engineers,
  };
}

/** Jobs with an engineer, route distance and crews that actually carry work. */
function planFacts(plan: PlanView): { assigned: number; distance: number; engineers: number } {
  const assigned = plan.assignments.filter(
    (item) => item.engineerId !== null && item.status !== 'unassigned',
  ).length;
  const distance = plan.routes.reduce((sum, route) => sum + route.distanceKm, 0);
  const engineers = plan.routes.filter((route) => route.assignedCount > 0).length;
  return { assigned, distance, engineers };
}

function roundKm(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Moscow wall clock. Plan times are Unix seconds. */
function moscowClock(unixSeconds: number): string {
  const shifted = new Date((unixSeconds + 3 * 60 * 60) * 1000);
  const hours = String(shifted.getUTCHours()).padStart(2, '0');
  const minutes = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function crewName(id: string | null, names: ReadonlyMap<string, string>): string {
  if (!id) return t('domain.dashboard.ae6bef78e3');
  return names.get(id) ?? id.slice(0, 8);
}

function lunchArrival(plan: PlanView): Map<string, number> {
  const result = new Map<string, number>();
  for (const route of plan.routes) {
    const lunch = route.stops.find((stop) => stop.kind === 'lunch');
    if (lunch) result.set(route.engineerId, lunch.arrivalAt);
  }
  return result;
}

function countSlaRisks(plan: PlanView): number {
  return plan.assignments.filter((item) => item.status === 'unassigned').length;
}

export function withPolicy(
  snapshot: DashboardSnapshot,
  policyId: DashboardSnapshot['policyId'],
): DashboardSnapshot {
  return { ...snapshot, policyId };
}

/**
 * Drops lunch stops from a fixture plan. Source plans keep lunch geometry so
 * the dashboard can turn the global switch on without inventing new points.
 */
export function planWithLunches(plan: PlanView, enabled: boolean): PlanView {
  if (enabled) {
    return plan;
  }
  return {
    ...plan,
    routes: plan.routes.map((route) => ({
      ...route,
      lunchStatus: 'none' as const,
      lunchTimeSec: 0,
      stops: route.stops.filter((stop) => stop.kind !== 'lunch'),
    })),
  };
}

/**
 * Applies the dashboard lunch switch to every engineer day. `lunch.taken` stays
 * a fact and is not cleared by the switch (context/32 §8, context/50 §3).
 */
export function withLunches(snapshot: DashboardSnapshot, enabled: boolean): DashboardSnapshot {
  return {
    ...snapshot,
    lunchesEnabled: enabled,
    engineers: snapshot.engineers.map((engineer) => {
      const day = engineer.day;
      if (!day) {
        return engineer;
      }
      return {
        ...engineer,
        day: {
          ...day,
          lunch: {
            enabled,
            durationSec: enabled ? 30 * 60 : null,
            windowStartAt: enabled ? day.shiftStartAt + 3 * 3600 + 20 * 60 : null,
            windowEndAt: enabled ? day.shiftStartAt + 5 * 3600 : null,
            required: enabled,
            taken: day.lunch.taken,
            startedAt: day.lunch.taken ? day.lunch.startedAt : null,
          },
        },
      };
    }),
  };
}

export function withPlan(
  snapshot: DashboardSnapshot,
  plan: PlanView,
  mode: DashboardSnapshot['plan']['mode'] = snapshot.plan.mode,
): DashboardSnapshot {
  return {
    ...snapshot,
    plan: {
      ...snapshot.plan,
      mode,
      plan,
    },
  };
}

/**
 * Projects a route onto the dispatcher map after work has become a fact.
 * Historical vertices remain in the route timeline, while the map keeps only
 * upcoming or in-progress jobs and redraws edges without historical geometry.
 */
export function remainingRouteForLiveMap(
  snapshot: DashboardSnapshot,
  route: PlanRouteView,
): PlanRouteView | null {
  const visibleRequestIds = new Set(
    snapshot.requests
      .filter(
        (request) =>
          request.lifecycle !== 'completed' &&
          request.lifecycle !== 'cancelled' &&
          (request.assumedCompletedAt === null || request.assumedCompletedAt === undefined),
      )
      .map((request) => request.id),
  );
  const stops = route.stops.filter(
    (stop) => stop.requestId === null || visibleRequestIds.has(stop.requestId),
  );
  if (!stops.some((stop) => stop.requestId !== null)) {
    return null;
  }
  return { ...route, stops, legs: [] };
}
