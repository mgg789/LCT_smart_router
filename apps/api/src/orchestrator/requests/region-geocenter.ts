export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface RegionPoint extends GeoPoint {
  readonly region: string;
}

const EARTH_RADIUS_M = 6_371_000;

/** Mean of the given points. Empty input returns null. */
export function geocenterOf(points: readonly GeoPoint[]): GeoPoint | null {
  if (points.length === 0) {
    return null;
  }
  let lat = 0;
  let lon = 0;
  for (const point of points) {
    lat += point.lat;
    lon += point.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}

/**
 * One geocenter per region from already-assigned request (or fallback) points.
 * Regions without a finite point are omitted.
 */
export function regionCenters(points: readonly RegionPoint[]): ReadonlyMap<string, GeoPoint> {
  const buckets = new Map<string, GeoPoint[]>();
  for (const point of points) {
    const region = point.region.trim();
    if (!region || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      continue;
    }
    const bucket = buckets.get(region) ?? [];
    bucket.push({ lat: point.lat, lon: point.lon });
    buckets.set(region, bucket);
  }
  const centers = new Map<string, GeoPoint>();
  for (const [region, bucket] of buckets) {
    const center = geocenterOf(bucket);
    if (center) {
      centers.set(region, center);
    }
  }
  return centers;
}

/** Region whose geocenter is closest to the point, or null when no centers exist. */
export function nearestRegion(
  point: GeoPoint,
  centers: ReadonlyMap<string, GeoPoint>,
): string | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || centers.size === 0) {
    return null;
  }
  let best: string | null = null;
  let bestMeters = Number.POSITIVE_INFINITY;
  for (const [region, center] of centers) {
    const meters = haversineMeters(point, center);
    if (meters < bestMeters) {
      bestMeters = meters;
      best = region;
    }
  }
  return best;
}

/** Great-circle distance in metres. */
export function haversineMeters(from: GeoPoint, to: GeoPoint): number {
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLon = toRadians(to.lon - from.lon);
  const chord =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(chord)));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
