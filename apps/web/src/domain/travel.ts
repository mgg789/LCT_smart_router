import type { PlanRouteView, TravelSource } from '../api/types';
import { routeLegs } from './dashboard';

export interface MapRouteSegment {
  readonly coordinates: ReadonlyArray<readonly [number, number]>;
  readonly source: TravelSource;
  readonly approximate: boolean;
}

/** Builds map line segments without presenting a straight approximation as road geometry. */
export function mapRouteSegments(route: PlanRouteView): MapRouteSegment[] {
  if (route.legs.length > 0) {
    return route.legs.map((leg) => {
      const providerPoints = leg.geometry?.points ?? [];
      // A prepared road graph (road_matrix) carries a real road polyline only when the
      // path has intermediate shape: a two-point road_matrix leg is the disclosed
      // node-to-node straightness of an un-enriched matrix, so it stays approximate
      // (card #66). Route/traffic APIs always return a snapped road shape.
      const exactRoadGeometry =
        leg.travelSource === 'route_api' ||
        leg.travelSource === 'traffic_api' ||
        (leg.travelSource === 'road_matrix' && providerPoints.length > 2);
      const exactGeometry =
        exactRoadGeometry && providerPoints.length >= 2
          ? providerPoints.map((point) => [point.lon, point.lat] as const)
          : null;
      const endpointGeometry =
        providerPoints.length >= 2
          ? [providerPoints[0], providerPoints[providerPoints.length - 1]]
              .filter((point) => point !== undefined)
              .map((point) => [point.lon, point.lat] as const)
          : null;
      const origin = stopBefore(route, leg.departureAt) ?? {
        lat: route.startLat,
        lon: route.startLon,
      };
      const destination = stopAtArrival(route, leg.arrivalAt) ?? origin;
      return {
        coordinates: exactGeometry ??
          endpointGeometry ?? [
            [origin.lon, origin.lat] as const,
            [destination.lon, destination.lat] as const,
          ],
        source: leg.travelSource,
        approximate: exactGeometry === null,
      };
    });
  }

  const fallbackLegs = routeLegs(route);
  return fallbackLegs.map((fallback) => {
    return {
      coordinates: [
        [fallback.from.lon, fallback.from.lat] as const,
        [fallback.to.lon, fallback.to.lat] as const,
      ],
      source: 'approximate',
      approximate: true,
    };
  });
}

function stopBefore(route: PlanRouteView, departureAt: number) {
  return [...route.stops]
    .filter((stop) => stop.endAt <= departureAt)
    .sort((left, right) => right.endAt - left.endAt || right.sequence - left.sequence)[0];
}

function stopAtArrival(route: PlanRouteView, arrivalAt: number) {
  return [...route.stops]
    .filter((stop) => stop.arrivalAt === arrivalAt)
    .sort((left, right) => left.sequence - right.sequence)[0];
}
