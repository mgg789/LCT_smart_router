import type { DashboardSnapshot } from '../api/types';

/**
 * Coordinates of a single request on the map.
 * Prefers the request's own pin; falls back to its planned stop. Never a route.
 */
export function requestMapPoint(
  snapshot: DashboardSnapshot,
  requestId: string,
): { lat: number; lon: number } | null {
  const request = snapshot.requests.find((item) => item.id === requestId);
  if (request?.lat != null && request.lon != null) {
    return { lat: request.lat, lon: request.lon };
  }
  for (const route of snapshot.plan.plan?.routes ?? []) {
    const stop = route.stops.find((item) => item.requestId === requestId);
    if (stop) return { lat: stop.lat, lon: stop.lon };
  }
  return null;
}
