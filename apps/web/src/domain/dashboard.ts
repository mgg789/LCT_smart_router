import type {
  DashboardSnapshot,
  PlanAssignmentView,
  PlanDelta,
  PlanRouteView,
  PlanView,
  RequestView,
} from '../api/types';

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

export function unassignedRequests(snapshot: DashboardSnapshot): RequestView[] {
  const plan = snapshot.plan.plan;
  if (!plan) {
    return snapshot.requests.filter((item) => item.assignmentState === 'unassigned');
  }
  const unassignedIds = new Set(
    plan.assignments.filter((item) => item.status === 'unassigned').map((item) => item.requestId),
  );
  return snapshot.requests.filter((item) => unassignedIds.has(item.id));
}

export function engineerSummaries(snapshot: DashboardSnapshot): EngineerSummary[] {
  return snapshot.engineers.map((engineer) => {
    const route = routeForEngineer(snapshot, engineer.id);
    const stops = route?.stops ?? [];
    const requestIds = stops.flatMap((stop) => (stop.requestId ? [stop.requestId] : []));
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
      assignedCount: route?.assignedCount ?? requestIds.length,
      doneCount,
      inProgressCount,
    };
  });
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

export type ActivityKind = 'not_started' | 'traveling' | 'on_site' | 'lunch' | 'finished';

export interface RouteVertex {
  readonly kind: 'start' | 'job' | 'lunch';
  readonly lat: number;
  readonly lon: number;
  readonly startAt: number;
  readonly endAt: number;
  readonly requestId: string | null;
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
    kind: stop.kind === 'lunch' ? ('lunch' as const) : ('job' as const),
    lat: stop.lat,
    lon: stop.lon,
    startAt: stop.startAt,
    endAt: stop.endAt,
    requestId: stop.requestId,
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
          label: 'Обед по плану',
        };
      }
      return {
        kind: 'on_site',
        engineerId,
        requestId: vertex.requestId,
        legIndex: null,
        lat: vertex.lat,
        lon: vertex.lon,
        label: 'На объекте по плану',
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
        label: 'В пути по плану — на участке, без точки',
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
      label: 'Ещё не выехал',
    };
  }

  return {
    kind: 'finished',
    engineerId,
    requestId: last.requestId,
    legIndex: null,
    lat: last.lat,
    lon: last.lon,
    label: 'Смена по плану закрыта',
  };
}

export function activityLabel(kind: ActivityKind): string {
  if (kind === 'traveling') {
    return 'в пути';
  }
  if (kind === 'on_site') {
    return 'на объекте';
  }
  if (kind === 'lunch') {
    return 'обед';
  }
  if (kind === 'finished') {
    return 'смена закрыта';
  }
  return 'не выехал';
}

export function computePlanDelta(before: PlanView, after: PlanView, solveMs: number): PlanDelta {
  const beforeByRequest = new Map(before.assignments.map((item) => [item.requestId, item]));
  let transferred = 0;
  let shifted = 0;
  const notes: string[] = [];

  for (const next of after.assignments) {
    const prev = beforeByRequest.get(next.requestId);
    if (!prev) {
      notes.push(`Новая заявка ${next.requestId} попала в план`);
      continue;
    }
    if (prev.engineerId !== next.engineerId && next.engineerId !== null) {
      transferred += 1;
      notes.push(`${next.requestId}: сменился исполнитель`);
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
      if (previousStart !== undefined && Math.abs(previousStart - stop.startAt) >= 5 * 60) {
        shifted += 1;
      }
    }
  }

  const slaBefore = countSlaRisks(before);
  const slaAfter = countSlaRisks(after);
  return { transferred, shifted, slaBefore, slaAfter, solveMs, notes };
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
