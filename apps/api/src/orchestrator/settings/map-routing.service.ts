import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PlanRouteSegmentView, PlanView } from '../../api/plan-view';
import { readRouterPhase, writeRouterPhase } from '../../routing/router-gateway/router-phase';
import { DispatcherSettingsService } from './dispatcher-settings.service';

/** A down road API must not hold a plan read. A live local `/route2` answers well inside this. */
const FETCH_TIMEOUT_MS = 1_500;
const CACHE_LIMIT = 400;
/** Paid geometry adds little information below this straight-line distance. */
export const MAP_API_MIN_DISTANCE_M = 300;
/** How long a road-shape miss (outage or outside MKAD) is remembered. */
/** A carriageway between two stops does not move. A one-minute TTL made every open dashboard re-request the whole day and the API stopped answering. */
const ROAD_SHAPE_TTL_MS = 6 * 60 * 60 * 1000;
/** A refused socket is not a stable answer. Retry on the next dashboard poll. */
const ROAD_MISS_TTL_MS = 8_000;
/** Enough to hide one slow edge. Each `/route2` on this stand is a few milliseconds. */
const ROAD_FETCH_CONCURRENCY = 4;
const TWOGIS_URL = 'https://routing.api.2gis.com/routing/7.0.0/global';
const YANDEX_URL = 'https://api.routing.yandex.net/v2/route';

export type MapProvider = 'twogis' | 'yandex';
type SurfaceTransport = 'car' | 'walk' | 'bike';

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
  private readonly roadShapeCache = new Map<
    string,
    { expiresAt: number; points: Array<{ lat: number; lon: number }> | null }
  >();
  /** In-flight road calls. The plan read never waits on them. */
  private shapeActive = 0;
  private readonly shapeSlots: Array<() => void> = [];
  private idleWait: Promise<void> = Promise.resolve();
  private idleRelease: (() => void) | null = null;
  private pendingShapes = 0;
  private readonly shapeQueued = new Set<string>();
  private watchedEdges: Array<{
    key: string;
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
  }> = [];

  constructor(
    @Inject(DispatcherSettingsService)
    private readonly settings: Pick<DispatcherSettingsService, 'read'>,
  ) {}

  async enrichPlan(
    plan: PlanView,
    trafficEnabled: boolean,
    transports: ReadonlyMap<string, string> = new Map(),
  ): Promise<PlanView> {
    const configured = await this.settings.read();
    if (!configured.twogisApiKey && !configured.yandexApiKey) {
      // No paid map provider. Exact lines are queued, never awaited on this call.
      return this.projectPlan(plan);
    }
    const routes = await Promise.all(
      plan.routes.map(async (route) => {
        const profile = transports.get(route.engineerId);
        if (!profile || !['car', 'walk', 'bike', 'transit'].includes(profile)) return route;
        const transport: SurfaceTransport =
          profile === 'car' ? 'car' : profile === 'bike' ? 'bike' : 'walk';
        const legs = await Promise.all(
          route.legs.map(async (leg) => {
            if (leg.segments?.length) {
              const isMetro = leg.segments.some((segment) => segment.travelSource === 'metro');
              const segments = await Promise.all(
                leg.segments.map((segment) =>
                  segment.travelSource === 'metro'
                    ? segment
                    : this.enrichSegment(
                        segment,
                        isMetro ? 'walk' : transport,
                        !isMetro && trafficEnabled && transport === 'car',
                      ),
                ),
              );
              return {
                ...leg,
                segments,
                geometry: {
                  points: segments.flatMap((segment, index) =>
                    index === 0 ? segment.geometry.points : segment.geometry.points.slice(1),
                  ),
                },
              };
            }
            // Old metro plans without segment boundaries must never become driving routes.
            if (leg.travelSource === 'metro') return leg;
            const origin = leg.geometry?.points[0] ??
              pointBefore(route, leg.departureAt) ?? {
                lat: route.startLat,
                lon: route.startLon,
              };
            const destination = leg.geometry?.points.at(-1) ?? pointAt(route, leg.arrivalAt);
            if (!destination) {
              return leg;
            }
            const mapped = await this.route(
              { lat: origin.lat, lon: origin.lon },
              { lat: destination.lat, lon: destination.lon },
              trafficEnabled && transport === 'car',
              transport,
            );
            if (!mapped || mapped.points.length < 2) {
              return leg;
            }
            return {
              ...leg,
              geometry: {
                points: withEndpoints(mapped.points, origin, destination),
              },
              // Decoration cannot rewrite accepted costs while leaving arrival times intact.
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
    transport: SurfaceTransport = 'car',
  ): Promise<MapRoute | null> {
    if (straightLineMetres(from, to) <= MAP_API_MIN_DISTANCE_M) return null;
    traffic = traffic && transport === 'car';
    const settings = await this.settings.read();
    const cacheKey = createHash('sha256')
      .update(
        JSON.stringify({
          from: roundPoint(from),
          to: roundPoint(to),
          traffic,
          transport,
          twogis: Boolean(settings.twogisApiKey),
          yandex: Boolean(settings.yandexApiKey),
        }),
      )
      .digest('hex');
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const fetched = await this.resolve(
      from,
      to,
      traffic,
      settings.twogisApiKey,
      settings.yandexApiKey,
      transport,
    );
    if (fetched) {
      this.remember(cacheKey, fetched);
    }
    return fetched;
  }

  /**
   * Plan for the screen, right now.
   *
   * Cached polylines are applied. Missing ones are fetched after this returns,
   * a few edges at a time, and only once the router is not building. The caller
   * must not await the road API.
   */
  projectPlan(plan: PlanView): PlanView {
    const base = roadApiBase();
    const building = readRouterPhase().phase === 'building';
    const edges = base ? this.neededEdges(plan) : [];
    this.watchedEdges = edges;
    let done = 0;
    for (const edge of edges) {
      if (this.freshShape(edge.key) !== undefined) {
        done += 1;
        continue;
      }
      if (!base || building || this.shapeQueued.has(edge.key)) continue;
      this.shapeQueued.add(edge.key);
      this.enqueueShape(base, edge);
    }
    writeRouterPhase({
      geometryDone: building ? 0 : done,
      geometryTotal: building ? 0 : edges.length,
    });
    return this.applyCachedShapes(plan);
  }

  /** Resolves when every queued road call has settled. Tests use this. */
  whenIdle(): Promise<void> {
    return this.idleWait;
  }

  /** Up to {@link ROAD_FETCH_CONCURRENCY} edges at once. One slow call must not hold the day. */
  private enqueueShape(
    base: string,
    job: { key: string; from: { lat: number; lon: number }; to: { lat: number; lon: number } },
  ): void {
    this.pendingShapes += 1;
    if (!this.idleRelease) {
      this.idleWait = new Promise((resolve) => {
        this.idleRelease = resolve;
      });
    }
    const run = () => {
      this.shapeActive += 1;
      void this.fetchRoadPolylineBounded(base, job.key, job.from, job.to)
        .catch(() => undefined)
        .finally(() => {
          this.shapeQueued.delete(job.key);
          this.publishGeometry();
          this.shapeActive -= 1;
          this.pendingShapes -= 1;
          if (this.pendingShapes === 0) {
            this.idleRelease?.();
            this.idleRelease = null;
          }
          const next = this.shapeSlots.shift();
          if (next) next();
        });
    };
    if (this.shapeActive < ROAD_FETCH_CONCURRENCY) run();
    else this.shapeSlots.push(run);
  }

  private publishGeometry(): void {
    const total = this.watchedEdges.length;
    const done = this.watchedEdges.filter((edge) => this.freshShape(edge.key) !== undefined).length;
    writeRouterPhase({ geometryDone: done, geometryTotal: total });
  }

  private freshShape(
    key: string,
  ): Array<{ lat: number; lon: number }> | null | undefined {
    const cached = this.roadShapeCache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) return undefined;
    return cached.points;
  }

  private neededEdges(plan: PlanView): Array<{
    key: string;
    from: { lat: number; lon: number };
    to: { lat: number; lon: number };
  }> {
    const base = roadApiBase();
    if (!base) return [];
    const edges: Array<{
      key: string;
      from: { lat: number; lon: number };
      to: { lat: number; lon: number };
    }> = [];
    const seen = new Set<string>();
    for (const route of plan.routes) {
      for (const leg of route.legs) {
        const pairs = leg.segments?.length
          ? leg.segments.flatMap((segment) => {
              if (!needsRoadShape(segment.travelSource, segment.geometry.points.length)) return [];
              const from = segment.geometry.points[0];
              const to = segment.geometry.points.at(-1);
              return from && to ? [{ from, to }] : [];
            })
          : [];
        const direct =
          pairs.length > 0 || leg.travelSource === 'metro' || !needsRoadShape(leg.travelSource, leg.geometry?.points.length ?? 0)
            ? pairs
            : (() => {
                const from = leg.geometry?.points[0] ??
                  pointBefore(route, leg.departureAt) ?? { lat: route.startLat, lon: route.startLon };
                const to = leg.geometry?.points.at(-1) ?? pointAt(route, leg.arrivalAt);
                return to ? [{ from, to }] : [];
              })();
        for (const pair of direct) {
          const key = this.shapeKey(base, pair.from, pair.to);
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ key, from: pair.from, to: pair.to });
        }
      }
    }
    return edges;
  }

  private shapeKey(
    base: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
  ): string {
    return createHash('sha256')
      .update(JSON.stringify({ road: roundPoint(from), to: roundPoint(to), base }))
      .digest('hex');
  }

  private applyCachedShapes(plan: PlanView): PlanView {
    return {
      ...plan,
      routes: plan.routes.map((route) => ({
        ...route,
        legs: route.legs.map((leg) => {
          if (leg.segments?.length) {
            const segments = leg.segments.map((segment) => this.applyCachedSegment(segment));
            const changed = segments.some((segment, index) => segment !== leg.segments?.[index]);
            if (!changed) return leg;
            return {
              ...leg,
              segments,
              geometry: {
                points: segments.flatMap((segment, index) =>
                  index === 0 ? segment.geometry.points : segment.geometry.points.slice(1),
                ),
              },
            };
          }
          if (
            leg.travelSource === 'metro' ||
            !needsRoadShape(leg.travelSource, leg.geometry?.points.length ?? 0)
          ) {
            return leg;
          }
          const from = leg.geometry?.points[0] ??
            pointBefore(route, leg.departureAt) ?? { lat: route.startLat, lon: route.startLon };
          const to = leg.geometry?.points.at(-1) ?? pointAt(route, leg.arrivalAt);
          if (!to) return leg;
          const points = this.freshShape(this.shapeKey(roadApiBase() ?? '', from, to));
          if (!points) return leg;
          return {
            ...leg,
            geometry: { points: withEndpoints(points, from, to) },
            travelSource: 'traffic_api' as const,
          };
        }),
      })),
    };
  }

  private applyCachedSegment(segment: PlanRouteSegmentView): PlanRouteSegmentView {
    if (!needsRoadShape(segment.travelSource, segment.geometry.points.length)) return segment;
    const from = segment.geometry.points[0];
    const to = segment.geometry.points.at(-1);
    if (!from || !to) return segment;
    const points = this.freshShape(this.shapeKey(roadApiBase() ?? '', from, to));
    if (!points) return segment;
    return {
      ...segment,
      geometry: { points: withEndpoints(points, from, to) },
      travelSource: 'traffic_api',
    };
  }

  /**
   * One road call that always settles.
   * A hung socket used to freeze the serial queue, so the map toast stayed
   * just short of the last edge. A miss is cached and counts as finished.
   */
  private async fetchRoadPolylineBounded(
    base: string,
    key: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const points = await Promise.race([
      this.fetchRoadPolyline(base, key, from, to),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 10_000);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (this.freshShape(key) === undefined) {
      this.roadShapeCache.set(key, { expiresAt: Date.now() + ROAD_MISS_TTL_MS, points });
    }
  }

  /** On-road polyline, or null when the backend is down or the pair leaves MKAD. */
  private async fetchRoadPolyline(
    base: string,
    key: string,
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
  ): Promise<Array<{ lat: number; lon: number }> | null> {
    const url = new URL('/route2', `${base}/`);
    url.searchParams.set('a', `${from.lat},${from.lon}`);
    url.searchParams.set('b', `${to.lat},${to.lon}`);
    let json: unknown;
    try {
      json = await requestJson(url, { headers: { Accept: 'application/json' } }, 8_000);
    } catch {
      this.roadShapeCache.set(key, { expiresAt: Date.now() + ROAD_MISS_TTL_MS, points: null });
      return null;
    }
    const points = decodeRoadPolyline(json);
    // A drawn road and a real straight (outside the graph) stay for the day.
    // Anything else is a transient miss and is retried on the next poll.
    // A real road stays for the day. A straight answer is not a finished road:
    // the next plan read asks again instead of pinning a dashed chord for hours.
    const ttl = points ? ROAD_SHAPE_TTL_MS : ROAD_MISS_TTL_MS;
    this.roadShapeCache.set(key, { expiresAt: Date.now() + ttl, points });
    if (this.roadShapeCache.size > CACHE_LIMIT) {
      const first = this.roadShapeCache.keys().next().value;
      if (typeof first === 'string') this.roadShapeCache.delete(first);
    }
    return points;
  }

  private async enrichSegment(
    segment: PlanRouteSegmentView,
    transport: SurfaceTransport,
    traffic: boolean,
  ): Promise<PlanRouteSegmentView> {
    const from = segment.geometry.points[0];
    const to = segment.geometry.points.at(-1);
    if (!from || !to) return segment;
    const mapped = await this.route(from, to, traffic, transport);
    return mapped && mapped.points.length >= 2
      ? {
          ...segment,
          geometry: { points: withEndpoints(mapped.points, from, to) },
          geometryProvider: mapped.provider,
        }
      : segment;
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
    transport: SurfaceTransport,
  ): Promise<MapRoute | null> {
    if (twogisKey && yandexKey) {
      const [twogis, yandex] = await Promise.allSettled([
        this.fetchTwogis(from, to, traffic, twogisKey, transport),
        this.fetchYandex(from, to, traffic, yandexKey, transport),
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
      return this.fetchTwogis(from, to, traffic, twogisKey, transport).catch(() => null);
    }
    if (yandexKey) {
      return this.fetchYandex(from, to, traffic, yandexKey, transport).catch(() => null);
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
    transport: SurfaceTransport = 'car',
  ): Promise<MapRoute | null> {
    const url = new URL(TWOGIS_URL);
    url.searchParams.set('key', key);
    const body = {
      points: [
        { type: 'stop', lon: from.lon, lat: from.lat },
        { type: 'stop', lon: to.lon, lat: to.lat },
      ],
      locale: 'ru',
      transport: transport === 'car' ? 'driving' : transport === 'bike' ? 'bicycle' : 'walking',
      route_mode: 'fastest',
      ...(transport === 'car' ? { traffic_mode: traffic ? 'jam' : 'statistics' } : {}),
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
    const total = first as { total_distance?: unknown; total_duration?: unknown };
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
    transport: SurfaceTransport = 'car',
  ): Promise<MapRoute | null> {
    const url = new URL(YANDEX_URL);
    url.searchParams.set('apikey', key);
    url.searchParams.set('waypoints', `${from.lat},${from.lon}|${to.lat},${to.lon}`);
    url.searchParams.set(
      'mode',
      transport === 'walk' ? 'walking' : transport === 'bike' ? 'bicycle' : 'driving',
    );
    if (transport === 'car' && !traffic) url.searchParams.set('traffic', 'disabled');
    const json = await requestJson(url, { headers: { Accept: 'application/json' } });
    if (!json || typeof json !== 'object') {
      return null;
    }
    const points = extractYandexPoints(json);
    if (points.length < 2) {
      return null;
    }
    const distanceKm =
      Number((json as { route?: { distance?: { value?: unknown } } }).route?.distance?.value ?? 0) /
      1000;
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

function roadApiBase(): string | null {
  const raw = process.env.ROUTER_ROAD_API_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, '');
}

/** A two-point chord is not a road. Metro rides and an existing road polyline stay. */
function needsRoadShape(source: PlanRouteSegmentView['travelSource'], pointCount: number): boolean {
  if (source === 'metro') return false;
  if ((source === 'route_api' || source === 'traffic_api') && pointCount >= 2) return false;
  return pointCount <= 2 || source === 'approximate' || source === 'road_matrix';
}

function decodeRoadPolyline(json: unknown): Array<{ lat: number; lon: number }> | null {
  if (!json || typeof json !== 'object') return null;
  const body = json as { mode?: unknown; geometry?: unknown };
  if (body.mode !== 'road' || !Array.isArray(body.geometry) || body.geometry.length < 3) return null;
  const points = body.geometry.flatMap((pair) => {
    if (!Array.isArray(pair) || pair.length < 2) return [];
    const lat = Number(pair[0]);
    const lon = Number(pair[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [{ lat, lon }];
  });
  return points.length >= 3 ? points : null;
}

function straightLineMetres(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const radians = Math.PI / 180;
  const value =
    Math.sin(((to.lat - from.lat) * radians) / 2) ** 2 +
    Math.cos(from.lat * radians) *
      Math.cos(to.lat * radians) *
      Math.sin(((to.lon - from.lon) * radians) / 2) ** 2;
  return 6_371_008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(value)));
}

function withEndpoints(
  points: ReadonlyArray<{ lat: number; lon: number }>,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): Array<{ lat: number; lon: number }> {
  return [from, ...points, to].filter(
    (point, index, all) =>
      index === 0 || point.lat !== all[index - 1]?.lat || point.lon !== all[index - 1]?.lon,
  );
}

async function requestJson(url: URL, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  if (value && typeof value === 'object' && 'selection' in value) {
    return pointsFromUnknown(value.selection);
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
      if ('selection' in item) return pointsFromUnknown(item.selection);
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
