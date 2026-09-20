import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PlanView } from '../../api/plan-view';
import { DispatcherSettingsService } from './dispatcher-settings.service';

const FETCH_TIMEOUT_MS = 5_000;
const CACHE_LIMIT = 400;
const TWOGIS_URL = 'https://routing.api.2gis.com/routing/7.0.0/global';
const YANDEX_URL = 'https://api.routing.yandex.net/v2/route';

export type MapProvider = 'twogis' | 'yandex';

export interface MapRoute {
  readonly provider: MapProvider;
  readonly points: ReadonlyArray<{ readonly lat: number; readonly lon: number }>;
  readonly distanceKm: number;
  readonly durationSec: number;
  readonly traffic: boolean;
}

export interface MapProviderStatus {
  readonly provider: MapProvider;
  readonly configured: boolean;
  readonly ok: boolean | null;
  readonly message: string;
}

/**
 * 2GIS / Yandex road geometry for planned legs.
 *
 * Both providers are queried in parallel when both keys exist. A 2GIS success wins
 * even if Yandex also answered; Yandex is the fallback when 2GIS is missing or fails.
 * No keys means the plan keeps Router's OSRM / centroid geometry.
 */
@Injectable()
export class MapRoutingService {
  private readonly cache = new Map<string, MapRoute>();

  constructor(private readonly settings: DispatcherSettingsService) {}

  async enrichPlan(plan: PlanView, trafficEnabled: boolean): Promise<PlanView> {
    const configured = await this.settings.read();
    if (!configured.twogisApiKey && !configured.yandexApiKey) {
      return plan;
    }
    const routes = await Promise.all(
      plan.routes.map(async (route) => {
        const legs = await Promise.all(
          route.legs.map(async (leg) => {
            const origin = pointBefore(route, leg.departureAt) ?? {
              lat: route.startLat,
              lon: route.startLon,
            };
            const destination = pointAt(route, leg.arrivalAt);
            if (!destination) {
              return leg;
            }
            const mapped = await this.route(
              { lat: origin.lat, lon: origin.lon },
              { lat: destination.lat, lon: destination.lon },
              trafficEnabled,
            );
            if (!mapped || mapped.points.length < 2) {
              return leg;
            }
            return {
              ...leg,
              geometry: { points: mapped.points.map((point) => ({ lat: point.lat, lon: point.lon })) },
              travelSource: (mapped.traffic ? 'traffic_api' : 'route_api') as typeof leg.travelSource,
              trafficFactor: mapped.traffic
                ? Math.max(1, mapped.durationSec / Math.max(1, leg.travelTimeSec))
                : leg.trafficFactor,
              distanceKm: mapped.distanceKm > 0 ? mapped.distanceKm : leg.distanceKm,
              travelTimeSec: mapped.durationSec > 0 ? mapped.durationSec : leg.travelTimeSec,
              geometryProvider: mapped.provider,
            };
          }),
        );
        return { ...route, legs };
      }),
    );
    return { ...plan, routes };
  }

  async route(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    traffic: boolean,
  ): Promise<MapRoute | null> {
    const settings = await this.settings.read();
    const cacheKey = createHash('sha256')
      .update(
        JSON.stringify({
          from: roundPoint(from),
          to: roundPoint(to),
          traffic,
          twogis: Boolean(settings.twogisApiKey),
          yandex: Boolean(settings.yandexApiKey),
        }),
      )
      .digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const fetched = await this.resolve(from, to, traffic, settings.twogisApiKey, settings.yandexApiKey);
    if (fetched) {
      this.remember(cacheKey, fetched);
    }
    return fetched;
  }

  async probe(): Promise<{
    readonly active: MapProvider | 'none';
    readonly twogis: MapProviderStatus;
    readonly yandex: MapProviderStatus;
  }> {
    const settings = await this.settings.read();
    const sampleFrom = { lat: 55.7558, lon: 37.6173 };
    const sampleTo = { lat: 55.7601, lon: 37.6189 };
    const [twogis, yandex] = await Promise.all([
      this.probeProvider('twogis', settings.twogisApiKey, sampleFrom, sampleTo),
      this.probeProvider('yandex', settings.yandexApiKey, sampleFrom, sampleTo),
    ]);
    const active: MapProvider | 'none' = twogis.ok ? 'twogis' : yandex.ok ? 'yandex' : 'none';
    return { active, twogis, yandex };
  }

  private async resolve(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    traffic: boolean,
    twogisKey: string | null,
    yandexKey: string | null,
  ): Promise<MapRoute | null> {
    if (twogisKey && yandexKey) {
      const [twogis, yandex] = await Promise.allSettled([
        this.fetchTwogis(from, to, traffic, twogisKey),
        this.fetchYandex(from, to, traffic, yandexKey),
      ]);
      if (twogis.status === 'fulfilled' && twogis.value) {
        return twogis.value;
      }
      if (yandex.status === 'fulfilled' && yandex.value) {
        return yandex.value;
      }
      return null;
    }
    if (twogisKey) {
      return this.fetchTwogis(from, to, traffic, twogisKey).catch(() => null);
    }
    if (yandexKey) {
      return this.fetchYandex(from, to, traffic, yandexKey).catch(() => null);
    }
    return null;
  }

  private async probeProvider(
    provider: MapProvider,
    key: string | null,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
  ): Promise<MapProviderStatus> {
    if (!key) {
      return { provider, configured: false, ok: null, message: 'Токен не задан' };
    }
    try {
      const route =
        provider === 'twogis'
          ? await this.fetchTwogis(from, to, false, key)
          : await this.fetchYandex(from, to, false, key);
      if (!route || route.points.length < 2) {
        return { provider, configured: true, ok: false, message: 'Маршрут не вернулся' };
      }
      return { provider, configured: true, ok: true, message: 'Маршрут строится' };
    } catch {
      return { provider, configured: true, ok: false, message: 'Провайдер не ответил' };
    }
  }

  private async fetchTwogis(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    traffic: boolean,
    key: string,
  ): Promise<MapRoute | null> {
    const url = new URL(TWOGIS_URL);
    url.searchParams.set('key', key);
    const body = {
      points: [
        { type: 'stop', lon: from.lon, lat: from.lat },
        { type: 'stop', lon: to.lon, lat: to.lat },
      ],
      locale: 'ru',
      transport: 'driving',
      route_mode: 'fastest',
      traffic_mode: traffic ? 'jam' : 'statistics',
      output: 'detailed',
    };
    const json = await requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!json || typeof json !== 'object') {
      return null;
    }
    const result = (json as { result?: unknown }).result;
    const first = Array.isArray(result) ? result[0] : null;
    if (!first || typeof first !== 'object') {
      return null;
    }
    const points = extractTwogisPoints(first);
    if (points.length < 2) {
      return null;
    }
    const total = (first as { total_distance?: unknown; total_duration?: unknown });
    return {
      provider: 'twogis',
      points,
      distanceKm: Number(total.total_distance ?? 0) / 1000,
      durationSec: Math.round(Number(total.total_duration ?? 0)),
      traffic,
    };
  }

  private async fetchYandex(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    traffic: boolean,
    key: string,
  ): Promise<MapRoute | null> {
    const url = new URL(YANDEX_URL);
    url.searchParams.set('apikey', key);
    url.searchParams.set('waypoints', `${from.lat},${from.lon}|${to.lat},${to.lon}`);
    url.searchParams.set('mode', traffic ? 'driving' : 'driving');
    if (traffic) {
      url.searchParams.set('traffic', 'enabled');
    }
    const json = await requestJson(url, { headers: { Accept: 'application/json' } });
    if (!json || typeof json !== 'object') {
      return null;
    }
    const points = extractYandexPoints(json);
    if (points.length < 2) {
      return null;
    }
    const distanceKm = Number(
      (json as { route?: { distance?: { value?: unknown } } }).route?.distance?.value ?? 0,
    ) / 1000;
    const durationSec = Math.round(
      Number((json as { route?: { duration?: { value?: unknown } } }).route?.duration?.value ?? 0),
    );
    return { provider: 'yandex', points, distanceKm, durationSec, traffic };
  }

  private remember(key: string, route: MapRoute): void {
    this.cache.set(key, route);
    if (this.cache.size <= CACHE_LIMIT) {
      return;
    }
    const first = this.cache.keys().next().value;
    if (typeof first === 'string') {
      this.cache.delete(first);
    }
  }
}

async function requestJson(url: URL, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractTwogisPoints(result: object): Array<{ lat: number; lon: number }> {
  const maneuvers = (result as { maneuvers?: unknown }).maneuvers;
  if (Array.isArray(maneuvers)) {
    const points: Array<{ lat: number; lon: number }> = [];
    for (const maneuver of maneuvers) {
      if (!maneuver || typeof maneuver !== 'object') continue;
      const geometry = (maneuver as { outcoming_path?: { geometry?: unknown } }).outcoming_path
        ?.geometry;
      points.push(...pointsFromUnknown(geometry));
    }
    if (points.length >= 2) {
      return points;
    }
  }
  return pointsFromUnknown((result as { geometry?: unknown }).geometry);
}

function extractYandexPoints(payload: unknown): Array<{ lat: number; lon: number }> {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const route = (payload as { route?: unknown }).route;
  if (route && typeof route === 'object') {
    const legs = (route as { legs?: unknown }).legs;
    if (Array.isArray(legs)) {
      const points: Array<{ lat: number; lon: number }> = [];
      for (const leg of legs) {
        if (!leg || typeof leg !== 'object') continue;
        const steps = (leg as { steps?: unknown }).steps;
        if (!Array.isArray(steps)) continue;
        for (const step of steps) {
          if (!step || typeof step !== 'object') continue;
          points.push(
            ...pointsFromUnknown((step as { polyline?: { points?: unknown } }).polyline?.points),
          );
        }
      }
      if (points.length >= 2) {
        return points;
      }
    }
    const encoded = (route as { encodedCoordinates?: unknown }).encodedCoordinates;
    if (typeof encoded === 'string') {
      return decodePolyline(encoded);
    }
  }
  return pointsFromUnknown((payload as { coordinates?: unknown }).coordinates);
}

function pointsFromUnknown(value: unknown): Array<{ lat: number; lon: number }> {
  if (typeof value === 'string') {
    return parseLineString(value);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (Array.isArray(item) && item.length >= 2) {
      const first = Number(item[0]);
      const second = Number(item[1]);
      if (!Number.isFinite(first) || !Number.isFinite(second)) return [];
      // GeoJSON is lon,lat; Yandex steps are often lat,lon. Heuristic: Moscow lat ~55.
      if (Math.abs(first) <= 90 && Math.abs(second) <= 180 && Math.abs(first) > 40) {
        return [{ lat: first, lon: second }];
      }
      return [{ lon: first, lat: second }];
    }
    if (item && typeof item === 'object') {
      const lat = Number((item as { lat?: unknown }).lat);
      const lon = Number((item as { lon?: unknown }).lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return [{ lat, lon }];
      }
    }
    return [];
  });
}

function parseLineString(value: string): Array<{ lat: number; lon: number }> {
  const match = /LINESTRING\s*\((.+)\)/i.exec(value);
  const body = match?.[1] ?? '';
  return body.split(',').flatMap((pair) => {
    const [lonText, latText] = pair.trim().split(/\s+/);
    const lon = Number(lonText);
    const lat = Number(latText);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [{ lat, lon }] : [];
  });
}

/** Encoded polyline used by some Yandex routing payloads. */
function decodePolyline(encoded: string): Array<{ lat: number; lon: number }> {
  const points: Array<{ lat: number; lon: number }> = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e5, lon: lon / 1e5 });
  }
  return points;
}

function roundPoint(point: { lat: number; lon: number }) {
  return { lat: Number(point.lat.toFixed(5)), lon: Number(point.lon.toFixed(5)) };
}

function pointBefore(
  route: PlanView['routes'][number],
  departureAt: number,
): { lat: number; lon: number } | null {
  const stop = [...route.stops]
    .filter((item) => item.endAt <= departureAt)
    .sort((left, right) => right.endAt - left.endAt || right.sequence - left.sequence)[0];
  return stop ? { lat: stop.lat, lon: stop.lon } : null;
}

function pointAt(
  route: PlanView['routes'][number],
  arrivalAt: number,
): { lat: number; lon: number } | null {
  const stop = [...route.stops]
    .filter((item) => item.arrivalAt === arrivalAt)
    .sort((left, right) => left.sequence - right.sequence)[0];
  return stop ? { lat: stop.lat, lon: stop.lon } : null;
}
