import type { AppliedPlanCurrentShape } from './plan-view.types';

export type TravelSource = 'approximate' | 'road_matrix' | 'route_api' | 'traffic_api';

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
  readonly legs: PlanRouteLegView[];
  readonly stops: PlanStopView[];
}

/** One planned movement between stops, with geometry only when Router had a road route. */
export interface PlanRouteLegView {
  readonly legId: string;
  readonly fromStopId: string | null;
  readonly toStopId: string;
  readonly departureAt: number;
  readonly arrivalAt: number;
  readonly travelTimeSec: number;
  readonly distanceKm: number;
  readonly geometry: {
    readonly points: Array<{ readonly lat: number; readonly lon: number }>;
  } | null;
  readonly travelSource: TravelSource;
  readonly trafficFactor: number;
  /** Present when sys replaced Router geometry with a map-provider polyline. */
  readonly geometryProvider?: 'twogis' | 'yandex';
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
      legs: planLegs(route.legs),
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

function planLegs(value: unknown): PlanRouteLegView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const leg = item as Record<string, unknown>;
    if (
      typeof leg.legId !== 'string' ||
      typeof leg.toStopId !== 'string' ||
      typeof leg.departureAt !== 'number' ||
      typeof leg.arrivalAt !== 'number' ||
      typeof leg.travelTimeSec !== 'number' ||
      typeof leg.distanceKm !== 'number' ||
      !isTravelSource(leg.travelSource) ||
      typeof leg.trafficFactor !== 'number' ||
      leg.trafficFactor < 1
    ) {
      return [];
    }
    const geometry = leg.geometry;
    const points =
      geometry &&
      typeof geometry === 'object' &&
      Array.isArray((geometry as { points?: unknown }).points)
        ? (geometry as { points: Array<{ lat: number; lon: number }> }).points
        : null;
    return [
      {
        legId: leg.legId,
        fromStopId: typeof leg.fromStopId === 'string' ? leg.fromStopId : null,
        toStopId: leg.toStopId,
        departureAt: leg.departureAt,
        arrivalAt: leg.arrivalAt,
        travelTimeSec: leg.travelTimeSec,
        distanceKm: leg.distanceKm,
        geometry: points ? { points } : null,
        travelSource: leg.travelSource,
        trafficFactor: leg.trafficFactor,
        ...(leg.geometryProvider === 'twogis' || leg.geometryProvider === 'yandex'
          ? { geometryProvider: leg.geometryProvider }
          : {}),
      },
    ];
  });
}

function isTravelSource(value: unknown): value is TravelSource {
  return (
    value === 'approximate' ||
    value === 'road_matrix' ||
    value === 'route_api' ||
    value === 'traffic_api'
  );
}
