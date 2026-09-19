import type { EngineerDayView, EngineerPlanResponse, PlanStopView, RequestView } from '../api/types';

export type EngineerJobVariant = 'upcoming' | 'regular';

export type EngineerJobItem = {
  readonly kind: 'job';
  readonly variant: EngineerJobVariant;
  readonly stop: PlanStopView;
  readonly request: RequestView;
};

export type EngineerLunchItem = {
  readonly kind: 'lunch';
  readonly startAt: number;
  readonly endAt: number;
};

export type EngineerListItem = EngineerJobItem | EngineerLunchItem;

/** A job still ahead of the engineer — not finished and not cancelled. */
export function isOpenJob(request: RequestView): boolean {
  return (
    request.lifecycle !== 'completed' &&
    request.lifecycle !== 'cancelled' &&
    request.assignmentState !== 'done'
  );
}

/**
 * Builds the Figma list: jobs in plan order, lunch where the solver placed it.
 * The first open job is the outlined «ближайшая» card.
 * When the route has no lunch stop but the day still has a lunch window, that
 * window is appended so the list and the menu stay consistent.
 */
export function engineerListItems(
  plan: EngineerPlanResponse | null,
  day: EngineerDayView | null,
): EngineerListItem[] {
  const items: EngineerListItem[] = [];
  const byId = new Map((plan?.requests ?? []).map((request) => [request.id, request]));
  let upcomingAssigned = false;

  for (const stop of plan?.route?.stops ?? []) {
    if (stop.kind === 'lunch') {
      items.push({ kind: 'lunch', startAt: stop.startAt, endAt: stop.endAt });
      continue;
    }
    if (stop.kind !== 'job' || stop.requestId === null) continue;
    const request = byId.get(stop.requestId);
    if (!request) continue;
    const upcoming = !upcomingAssigned && isOpenJob(request);
    if (upcoming) upcomingAssigned = true;
    items.push({
      kind: 'job',
      variant: upcoming ? 'upcoming' : 'regular',
      stop,
      request,
    });
  }

  if (!items.some((item) => item.kind === 'lunch')) {
    const lunch = lunchFromDay(day);
    if (lunch) items.push(lunch);
  }

  return items;
}

/** Lunch window for the menu row — planned stop first, then the day's window. */
export function engineerLunchWindow(
  plan: EngineerPlanResponse | null,
  day: EngineerDayView | null,
): EngineerLunchItem | null {
  const planned = plan?.route?.stops.find((stop) => stop.kind === 'lunch');
  if (planned) {
    return { kind: 'lunch', startAt: planned.startAt, endAt: planned.endAt };
  }
  return lunchFromDay(day);
}

/** Job ids on the route that the plan payload did not embed. */
export function missingRequestIds(plan: EngineerPlanResponse | null): string[] {
  if (!plan?.route) return [];
  const known = new Set(plan.requests.map((request) => request.id));
  const ids: string[] = [];
  for (const stop of plan.route.stops) {
    if (stop.kind !== 'job' || stop.requestId === null || known.has(stop.requestId)) continue;
    ids.push(stop.requestId);
  }
  return ids;
}

function lunchFromDay(day: EngineerDayView | null): EngineerLunchItem | null {
  if (!day?.lunch.enabled) return null;
  const startAt = day.lunch.windowStartAt;
  const endAt = day.lunch.windowEndAt;
  if (startAt === null || endAt === null) return null;
  return { kind: 'lunch', startAt, endAt };
}
