import type { AppliedPlanCurrentShape } from './plan-view.types';

/**
 * What an interface is given about the working plan.
 *
 * `planAsOf` travels with it on purpose: while a recalculation is under way the interface
 * keeps showing the last applied plan together with the moment it describes, rather than
 * clearing the day or borrowing the timestamp of a snapshot that has not been computed yet
 * (context/36 section 6).
 */
export interface PlanStopView {
  readonly sequence: number;
  readonly kind: string;
  readonly requestId: string | null;
  readonly lat: number;
  readonly lon: number;
  /** Computed schedule, never a confirmed fact. */
  readonly arrivalAt: number;
  readonly startAt: number;
  readonly endAt: number;
}

export interface PlanRouteView {
  readonly engineerId: string;
  readonly startLat: number;
  readonly startLon: number;
  readonly startAt: number | null;
  readonly finishAt: number | null;
  readonly distanceKm: number;
  readonly travelTimeSec: number;
  readonly workTimeSec: number;
  readonly waitingTimeSec: number;
  readonly lunchTimeSec: number;
  readonly assignedCount: number;
  readonly lunchStatus: string;
  readonly stops: PlanStopView[];
}

export interface PlanView {
  readonly revision: number;
  /** `auto` or `manual`; a manual plan must never look like a fresh calculation. */
  readonly origin: string;
  readonly planAsOf: number;
  readonly appliedAt: number;
  readonly routes: PlanRouteView[];
  readonly assignments: Array<{
    readonly requestId: string;
    readonly status: string;
    readonly engineerId: string | null;
    /** Checkable grounds from the solver, passed through unchanged. */
    readonly reasons: unknown;
  }>;
}

export function toPlanView(plan: AppliedPlanCurrentShape): PlanView {
  return {
    revision: plan.revision,
    origin: plan.origin,
    planAsOf: Number(plan.planAsOf),
    appliedAt: Number(plan.appliedAt),
    routes: plan.routes.map((route) => ({
      engineerId: route.engineerId,
      startLat: route.startLat,
      startLon: route.startLon,
      startAt: route.startAt === null ? null : Number(route.startAt),
      finishAt: route.finishAt === null ? null : Number(route.finishAt),
      distanceKm: route.distanceKm,
      travelTimeSec: route.travelTimeSec,
      workTimeSec: route.workTimeSec,
      waitingTimeSec: route.waitingTimeSec,
      lunchTimeSec: route.lunchTimeSec,
      assignedCount: route.assignedCount,
      lunchStatus: route.lunchStatus,
      stops: route.stops.map((stop) => ({
        sequence: stop.sequence,
        kind: stop.kind,
        requestId: stop.requestId,
        lat: stop.lat,
        lon: stop.lon,
        arrivalAt: Number(stop.arrivalAt),
        startAt: Number(stop.startAt),
        endAt: Number(stop.endAt),
      })),
    })),
    assignments: plan.assignments.map((item) => ({
      requestId: item.requestId,
      status: item.status,
      engineerId: item.engineerId,
      reasons: item.reasons,
    })),
  };
}
