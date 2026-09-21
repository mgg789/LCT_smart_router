import type { FeatureCollection, LineString, Point } from 'geojson';
import type { PlanRouteLegView, PlanRouteView } from '@/entities/plan';
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

export interface RouteLegProps extends Record<string, unknown> {
  /** `road` follows a real road shape; `straight` only joins two points. */
  shape: 'road' | 'straight';
}

export type RouteLineCollection = FeatureCollection<LineString, RouteLegProps>;

type LonLat = [number, number];

function isFinitePoint(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat);
}

/**
 * Whether a leg's points trace an actual road — the same rule `apps/web` draws by.
 *
 * Route and traffic APIs always answer with a road shape. A prepared road graph
 * (`road_matrix`) only does when the path has intermediate points: a two-point
 * `road_matrix` leg is the matrix's node-to-node straightness, disclosed as such,
 * and drawing it solid would pass a straight line off as a road.
 */
function tracesRoad(leg: PlanRouteLegView, points: number): boolean {
  if (points < 2) return false;
  if (leg.travelSource === 'route_api' || leg.travelSource === 'traffic_api') return true;
  return leg.travelSource === 'road_matrix' && points > 2;
}

/**
 * The selected crew's route, one feature per movement.
 *
 * A leg whose geometry traces a road (`routes[].legs[].geometry`, see
 * `tracesRoad`) is drawn along that road. Any other leg — an approximate travel
 * time, a bare two-point matrix leg, a plan stored before legs existed — is a
 * straight segment marked `straight`, so the map never passes a guess off as a
 * road.
 *
 * Legs come one per visit, in the route's order: lunch is taken where the crew
 * already stands and a wait sits on the visit's own address, so neither moves
 * anyone. A leg is matched to its visit by position and confirmed by time — it
 * ends when the visit's stop begins (`arrivalAt`). If the two disagree, the leg
 * is not trusted and the segment falls back to a straight line.
 */
export function buildRouteLine(route: PlanRouteView | null): RouteLineCollection {
  if (!route) return { type: 'FeatureCollection', features: [] };

  const visits = route.stops.filter(
    (stop) => stop.requestId !== null && stop.kind === 'job' && isFinitePoint(stop.lon, stop.lat),
  );
  const legs = route.legs ?? [];
  const features: RouteLineCollection['features'] = [];

  let from: LonLat | null = isFinitePoint(route.startLon, route.startLat)
    ? [route.startLon, route.startLat]
    : null;

  visits.forEach((visit, index) => {
    const to: LonLat = [visit.lon, visit.lat];
    const leg = legs[index];
    // A wait before the visit shares the leg's arrival, so either stop may carry it.
    const arrivals = route.stops
      .filter(
        (stop) =>
          stop.sequence <= visit.sequence && stop.lon === visit.lon && stop.lat === visit.lat,
      )
      .map((stop) => stop.arrivalAt);
    const matches = leg !== undefined && arrivals.includes(leg.arrivalAt);
    const points = matches
      ? (leg.geometry?.points ?? []).filter((p) => isFinitePoint(p.lon, p.lat))
      : [];

    if (matches && tracesRoad(leg, points.length)) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
        properties: { shape: 'road' },
      });
    } else if (from) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [from, to] },
        properties: { shape: 'straight' },
      });
    }
    from = to;
  });

  return { type: 'FeatureCollection', features };
}

export type MapBounds = [[number, number], [number, number]];

/** Grows a box to include one more coordinate. */
export function extendBounds(bounds: MapBounds | null, lon: number, lat: number): MapBounds {
  if (!bounds) {
    return [
      [lon, lat],
      [lon, lat],
    ];
  }
  const [[west, south], [east, north]] = bounds;
  return [
    [Math.min(west, lon), Math.min(south, lat)],
    [Math.max(east, lon), Math.max(north, lat)],
  ];
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

export interface RouteStopProps extends Record<string, unknown> {
  requestId: string | null;
  /** Position in the crew's day, starting at 1; the start point is not numbered. */
  order: number;
}

export type RouteStopCollection = FeatureCollection<Point, RouteStopProps>;

/**
 * The crew's stops as numbered points.
 *
 * Numbering follows the plan's own order, so what the map shows and what the
 * timeline lists below it cannot drift apart.
 */
export function buildRouteStopPoints(route: PlanRouteView | null): RouteStopCollection {
  if (!route) return { type: 'FeatureCollection', features: [] };

  // Only the visits are numbered. A `wait` stop sits at the coordinates of the
  // job that follows it, so numbering it too put two markers on one point and
  // the visit ended up wearing the wait's number.
  const visits = route.stops.filter(
    (stop) => stop.requestId !== null && Number.isFinite(stop.lon) && Number.isFinite(stop.lat),
  );

  return {
    type: 'FeatureCollection',
    features: visits.map((stop, index) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [stop.lon, stop.lat] },
      properties: { requestId: stop.requestId, order: index + 1 },
    })),
  };
}

/** Where the crew begins the day — drawn apart from the numbered stops. */
export function buildStartPoint(route: PlanRouteView | null): FeatureCollection<Point> {
  if (!route || !Number.isFinite(route.startLon) || !Number.isFinite(route.startLat)) {
    return { type: 'FeatureCollection', features: [] };
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [route.startLon, route.startLat] },
        properties: { label: 'Старт' },
      },
    ],
  };
}
