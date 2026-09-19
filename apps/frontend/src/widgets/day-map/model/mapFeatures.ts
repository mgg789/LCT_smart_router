import type { FeatureCollection, LineString, Point } from 'geojson';
import type { PlanRouteView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';

export type StopState = 'assigned' | 'unassigned' | 'completed' | 'running';

export interface RequestFeatureProps extends Record<string, unknown> {
  requestId: string;
  state: StopState;
  badge: string;
}

export type PointCollection = FeatureCollection<Point, RequestFeatureProps>;
export type LineCollection = FeatureCollection<LineString>;

const SKILL_BADGE: Record<string, string> = { local: 'Л', connection: 'П', emergency: 'А' };

function stateOf(request: RequestView): StopState {
  if (request.lifecycle === 'completed') return 'completed';
  if (request.lifecycle === 'in_progress') return 'running';
  if (request.assignmentState === 'unassigned') return 'unassigned';
  return 'assigned';
}

/**
 * Points for every request that actually has coordinates.
 *
 * A request without them is left off the map rather than pinned somewhere
 * plausible — empty coordinates are diagnostics, not a location.
 */
export function buildRequestPoints(requests: RequestView[]): PointCollection {
  return {
    type: 'FeatureCollection',
    features: requests
      .filter((request) => request.lat !== null && request.lon !== null)
      .filter((request) => request.lifecycle !== 'cancelled')
      .map((request) => ({
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [request.lon as number, request.lat as number],
        },
        properties: {
          requestId: request.id,
          state: stateOf(request),
          badge: SKILL_BADGE[request.requiredSkill] ?? '?',
        },
      })),
  };
}

/**
 * The selected crew's route as one straight, dashed line.
 *
 * The contract ships no road geometry for a leg, so nothing here claims to be a
 * road: straight dashed segments say "these points follow each other", which is
 * all the plan actually states (D-29).
 */
export function buildRouteLine(route: PlanRouteView | null): LineCollection {
  if (!route) return { type: 'FeatureCollection', features: [] };

  const coordinates: [number, number][] = [
    [route.startLon, route.startLat],
    ...route.stops
      .filter((stop) => Number.isFinite(stop.lon) && Number.isFinite(stop.lat))
      .map((stop) => [stop.lon, stop.lat] as [number, number]),
  ];

  if (coordinates.length < 2) return { type: 'FeatureCollection', features: [] };

  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} }],
  };
}

/** Bounding box of the points to fit, or `null` when there is nothing to show. */
export function boundsOf(points: PointCollection): [[number, number], [number, number]] | null {
  if (points.features.length === 0) return null;

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const feature of points.features) {
    const [lon, lat] = feature.geometry.coordinates as [number, number];
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [
    [west, south],
    [east, north],
  ];
}
