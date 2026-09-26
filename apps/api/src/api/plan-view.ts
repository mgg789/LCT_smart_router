import type {
  AssignmentReasons,
  PlanLegView,
  PlanRouteView,
  PlanStopView,
  PlanView,
  TravelSource,
} from '@lct/shared';
import { handoffMetadataSchema } from '../routing/router-gateway/result.types';
import type { AppliedPlanCurrentShape } from './plan-view.types';

export type { PlanLegView, PlanRouteView, PlanStopView, PlanView, TravelSource };

/** A contiguous part of one journey; metro vertices are geometry, not visit stops. */
export type PlanRouteSegmentView = NonNullable<PlanLegView['segments']>[number];

/** One planned movement between stops, with geometry only when Router had a road route. */
export type PlanRouteLegView = PlanLegView;

/**
 * What an interface is given about the working plan.
 *
 * `planAsOf` travels with it on purpose: while a recalculation is under way the interface
 * keeps showing the last applied plan together with the moment it describes, rather than
 * clearing the day or borrowing the timestamp of a snapshot that has not been computed yet
 * (context/36 section 6). The shape is `@lct/shared`.
 */

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
      lunchStatus: asLunchStatus(route.lunchStatus),
      legs: planLegs(route.legs),
      stops: route.stops.map((stop) => ({
        sequence: stop.sequence,
        handoff: handoffMetadataSchema.safeParse(stop.handoff).data ?? null,
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
      reasons: assignmentReasons(item.reasons),
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
        ...(Array.isArray(leg.segments) && leg.segments.length
          ? { segments: planSegments(leg.segments) }
          : {}),
        ...(leg.geometryProvider === 'twogis' || leg.geometryProvider === 'yandex'
          ? { geometryProvider: leg.geometryProvider }
          : {}),
      },
    ];
  });
}

const LUNCH_STATUSES = [
  'none',
  'planned',
  'taken',
  'skipped',
  'disabled',
  'already_taken',
  'scheduled',
  'skipped_for_work',
  'not_scheduled',
  'required_conflict',
] as const satisfies ReadonlyArray<PlanRouteView['lunchStatus']>;

/** Stored lunch status is a free string; only the contract vocabulary is shown. */
export function asLunchStatus(value: string): PlanRouteView['lunchStatus'] {
  for (const status of LUNCH_STATUSES) {
    if (status === value) return status;
  }
  return 'none';
}

/**
 * Solver reasons cross the process boundary as JSON. The object is kept when it is an
 * object; a missing or scalar payload becomes an empty explanation rather than a cast
 * of an unrelated value.
 */
function assignmentReasons(value: unknown): AssignmentReasons {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as AssignmentReasons;
  }
  return {};
}

function isTravelSource(value: unknown): value is TravelSource {
  return (
    value === 'approximate' ||
    value === 'road_matrix' ||
    value === 'route_api' ||
    value === 'traffic_api' ||
    value === 'metro'
  );
}

function planSegments(value: unknown[]): PlanRouteSegmentView[] {
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const segment = item as Record<string, unknown>;
    if (
      !isTravelSource(segment.travelSource) ||
      typeof segment.travelTimeSec !== 'number' ||
      !Number.isFinite(segment.travelTimeSec) ||
      segment.travelTimeSec < 0 ||
      typeof segment.distanceKm !== 'number' ||
      !Number.isFinite(segment.distanceKm) ||
      segment.distanceKm < 0 ||
      !segment.geometry ||
      typeof segment.geometry !== 'object'
    )
      return [];
    const points = (segment.geometry as { points?: unknown }).points;
    if (
      !Array.isArray(points) ||
      points.length < 2 ||
      !points.every(
        (point) =>
          point &&
          typeof point === 'object' &&
          Number.isFinite(point.lat) &&
          Number.isFinite(point.lon) &&
          Math.abs(point.lat) <= 90 &&
          Math.abs(point.lon) <= 180,
      )
    )
      return [];
    return [
      {
        geometry: {
          points: points.map((point: { lat: number; lon: number }) => ({
            lat: point.lat,
            lon: point.lon,
          })),
        },
        travelSource: segment.travelSource,
        travelTimeSec: segment.travelTimeSec,
        distanceKm: segment.distanceKm,
        ...(segment.geometryProvider === 'twogis' || segment.geometryProvider === 'yandex'
          ? { geometryProvider: segment.geometryProvider }
          : {}),
      },
    ];
  });
}
