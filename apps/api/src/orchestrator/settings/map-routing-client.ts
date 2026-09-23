import { createHash } from 'node:crypto';

export type MapProvider = 'twogis' | 'yandex';
export type MapTransport = 'car' | 'walk' | 'bike' | 'transit';
export type MapFailure =
  | 'not_configured'
  | 'unauthorized'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'no_route'
  | 'invalid_response'
  | 'unavailable'
  | 'unsupported_transport';
export interface MapPoint {
  readonly lat: number;
  readonly lon: number;
}
/** One provider observation. Epoch seconds describe freshness, never execution facts. */
export interface MapRoute {
  readonly provider: MapProvider;
  readonly points: ReadonlyArray<MapPoint>;
  readonly distanceKm: number;
  readonly durationSec: number;
  readonly traffic: boolean;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly cacheState: 'live' | 'cached' | 'stale';
}
/** Missing routes and provider outages must remain distinguishable to the forecast. */
export interface MapQuote {
  readonly route: MapRoute | null;
  readonly failure: MapFailure | null;
}
/** Safe provider diagnostics: no URLs, response bodies or credentials. Counters are process-local. */
export interface MapProviderStatus {
  readonly provider: MapProvider;
  readonly configured: boolean;
  readonly ok: boolean | null;
  readonly message: string;
  readonly code: MapFailure | 'ready' | 'not_checked';
  readonly checkedAt: number | null;
  readonly requests: number;
  readonly cacheHits: number;
}
type Credentials = { readonly twogisApiKey: string | null; readonly yandexApiKey: string | null };
type CacheEntry = { quote: MapQuote; retryAt: number };
type ProviderState = {
  code: MapProviderStatus['code'];
  checkedAt: number | null;
  requests: number;
  cacheHits: number;
  retryAt: number;
  attemptsAt: number[];
};
const FRESH_TRAFFIC_SEC = 300;
const FRESH_ROUTE_SEC = 900;
const MAX_STALE_SEC = 3600;
const MAX_CACHE_ENTRIES = 400;
const MESSAGES: Record<MapProviderStatus['code'], string> = {
  ready: 'Маршрут получен',
  not_checked: 'Ключ сохранён; маршрут ещё не запрашивался',
  not_configured: 'Токен не задан',
  unauthorized: 'Ключ отклонён или нет доступа к Routing API',
  quota: 'Лимит запросов провайдера; повторные обращения временно остановлены',
  rate_limit: 'Пауза: не более 5 маршрутов в минуту для тестового ключа',
  timeout: 'Провайдер не ответил за 5 секунд',
  network: 'Нет соединения с провайдером',
  no_route: 'Провайдер не нашёл проезд между точками',
  invalid_response: 'Некорректный ответ провайдера',
  unavailable: 'Сервис провайдера недоступен',
  unsupported_transport: 'Для этого транспорта используется оценка Router',
};

/** Bounded live routing with credential-scoped caches, single flight and failure backoff. */
export class MapRoutingClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<MapQuote>>();
  private readonly states = new Map<string, ProviderState>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly request: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Transaction-safe read: never starts I/O or upgrades an expired observation to live. */
  peek(
    from: MapPoint,
    to: MapPoint,
    traffic: boolean,
    transport: MapTransport,
    keys: Credentials,
  ): MapQuote {
    if (transport === 'transit') return { route: null, failure: 'unsupported_transport' };
    let stale: MapQuote | null = null;
    let failure: MapFailure =
      keys.twogisApiKey || keys.yandexApiKey ? 'unavailable' : 'not_configured';
    for (const provider of ['twogis', 'yandex'] as const) {
      const key = provider === 'twogis' ? keys.twogisApiKey : keys.yandexApiKey;
      if (!key || (provider === 'yandex' && transport !== 'car')) continue;
      const entry = this.cache.get(
        digest([provider, key, from, to, traffic && transport === 'car', transport]),
      );
      if (!entry) continue;
      if (entry.quote.failure === 'no_route') return entry.quote;
      const route = entry.quote.route;
      if (route && route.observedAt + MAX_STALE_SEC > this.now()) {
        const quote: MapQuote = {
          ...entry.quote,
          route: { ...route, cacheState: route.expiresAt > this.now() ? 'cached' : 'stale' },
        };
        if (route.expiresAt > this.now()) return quote;
        stale ??= quote;
      }
      if (entry.quote.failure) failure = entry.quote.failure;
    }
    return stale ?? { route: null, failure };
  }

  /** Prioritize 2GIS; another provider is contacted only after failure, never on a confirmed NoRoute. */
  async quote(
    from: MapPoint,
    to: MapPoint,
    traffic: boolean,
    transport: MapTransport,
    keys: Credentials,
  ): Promise<MapQuote> {
    if (!validPoint(from) || !validPoint(to)) return { route: null, failure: 'invalid_response' };
    if (transport === 'transit') return { route: null, failure: 'unsupported_transport' };
    let last: MapQuote = { route: null, failure: 'not_configured' };
    let stale: MapQuote | null = null;
    for (const provider of ['twogis', 'yandex'] as const) {
      const key = provider === 'twogis' ? keys.twogisApiKey : keys.yandexApiKey;
      if (!key) continue;
      if (provider === 'yandex' && transport !== 'car') continue;
      last = await this.providerQuote(
        provider,
        key,
        from,
        to,
        traffic && transport === 'car',
        transport,
      );
      if (last.failure === 'no_route') return last;
      if (last.route && last.route.cacheState !== 'stale') return last;
      if (last.route) stale ??= last;
    }
    return stale ?? last;
  }

  /** Reading health consumes zero billable requests; the real workload supplies evidence. */
  status(provider: MapProvider, key: string | null): MapProviderStatus {
    const state = key ? this.state(provider, key) : null;
    const code = state?.code ?? 'not_configured';
    return {
      provider,
      configured: Boolean(key),
      ok:
        code === 'ready'
          ? true
          : code === 'not_configured' || code === 'not_checked'
            ? null
            : false,
      code,
      message: MESSAGES[code],
      checkedAt: state?.checkedAt ?? null,
      requests: state?.requests ?? 0,
      cacheHits: state?.cacheHits ?? 0,
    };
  }

  private state(provider: MapProvider, key: string): ProviderState {
    const identity = digest([provider, key]);
    let state = this.states.get(identity);
    if (!state) {
      state = {
        code: 'not_checked',
        checkedAt: null,
        requests: 0,
        cacheHits: 0,
        retryAt: 0,
        attemptsAt: [],
      };
      this.states.set(identity, state);
    }
    return state;
  }

  private async providerQuote(
    provider: MapProvider,
    key: string,
    from: MapPoint,
    to: MapPoint,
    traffic: boolean,
    transport: MapTransport,
  ): Promise<MapQuote> {
    const identity = digest([provider, key, from, to, traffic, transport]);
    const state = this.state(provider, key);
    const cached = this.cache.get(identity);
    const now = this.now();
    if (cached && cached.retryAt > now) {
      state.cacheHits++;
      return {
        ...cached.quote,
        route:
          cached.quote.route && cached.quote.route.observedAt + MAX_STALE_SEC > now
            ? {
                ...cached.quote.route,
                cacheState: cached.quote.route.expiresAt > now ? 'cached' : 'stale',
              }
            : null,
      };
    }
    const pending = this.pending.get(identity);
    if (pending) {
      state.cacheHits++;
      return pending;
    }
    const task = this.fetchAndRemember(
      provider,
      key,
      from,
      to,
      traffic,
      transport,
      identity,
      cached,
      state,
    );
    this.pending.set(identity, task);
    try {
      return await task;
    } finally {
      this.pending.delete(identity);
    }
  }

  private async fetchAndRemember(
    provider: MapProvider,
    key: string,
    from: MapPoint,
    to: MapPoint,
    traffic: boolean,
    transport: MapTransport,
    identity: string,
    cached: CacheEntry | undefined,
    state: ProviderState,
  ): Promise<MapQuote> {
    // Four slots include response-body reads. A 205-stop plan cannot flood the provider.
    if (this.active >= 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    let quote: MapQuote;
    try {
      state.attemptsAt = state.attemptsAt.filter((at) => at > this.now() - 60);
      if (state.retryAt > this.now() && state.code !== 'ready' && state.code !== 'not_checked') {
        quote = { route: null, failure: state.code };
      } else if (provider === 'twogis' && state.attemptsAt.length >= 5) {
        quote = { route: null, failure: 'rate_limit' };
        state.code = 'rate_limit';
        state.retryAt = (state.attemptsAt[0] ?? this.now()) + 60;
      } else {
        state.requests++;
        state.attemptsAt.push(this.now());
        quote = await this.fetchRoute(provider, key, from, to, traffic, transport);
        state.code = quote.failure ?? 'ready';
        state.checkedAt = this.now();
        // Authentication is retried only after key rotation/restart; transient failures back off.
        state.retryAt =
          quote.failure === 'unauthorized'
            ? Number.POSITIVE_INFINITY
            : this.now() +
              (quote.failure === 'quota'
                ? 300
                : quote.failure && quote.failure !== 'no_route'
                  ? 30
                  : 0);
      }
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
    const now = this.now();
    const old = cached?.quote.route;
    if (
      !quote.route &&
      old &&
      old.observedAt + MAX_STALE_SEC > now &&
      quote.failure !== 'no_route' &&
      quote.failure !== 'unauthorized' &&
      quote.failure !== 'invalid_response'
    ) {
      quote = { ...quote, route: { ...old, cacheState: 'stale' } };
    }
    this.cache.delete(identity);
    this.cache.set(identity, {
      quote,
      retryAt: quote.route && !quote.failure ? quote.route.expiresAt : now + 30,
    });
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return quote;
  }

  private async fetchRoute(
    provider: MapProvider,
    key: string,
    from: MapPoint,
    to: MapPoint,
    traffic: boolean,
    transport: MapTransport,
  ): Promise<MapQuote> {
    const url = new URL(
      provider === 'twogis'
        ? 'https://routing.api.2gis.com/routing/7.0.0/global'
        : 'https://api.routing.yandex.net/v2/route',
    );
    url.searchParams.set(provider === 'twogis' ? 'key' : 'apikey', key);
    const signal = AbortSignal.timeout(5000);
    let init: RequestInit = { headers: { Accept: 'application/json' }, signal };
    if (provider === 'twogis') {
      init = {
        ...init,
        method: 'POST',
        headers: { ...init.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: [
            { type: 'stop', ...from },
            { type: 'stop', ...to },
          ],
          transport:
            transport === 'walk' ? 'walking' : transport === 'bike' ? 'bicycle' : 'driving',
          route_mode: 'fastest',
          ...(transport === 'car' ? { traffic_mode: traffic ? 'jam' : 'statistics' } : {}),
          locale: 'ru',
          output: 'detailed',
          alternative: 0,
        }),
      };
    } else {
      url.searchParams.set('waypoints', `${from.lat},${from.lon}|${to.lat},${to.lon}`);
      url.searchParams.set('mode', 'driving');
      if (traffic) url.searchParams.set('traffic', 'enabled');
    }
    try {
      const response = await this.request(url, init);
      if (!response.ok)
        return {
          route: null,
          failure:
            response.status === 401 || response.status === 403
              ? 'unauthorized'
              : response.status === 429
                ? 'quota'
                : 'unavailable',
        };
      const body: unknown = await response.json();
      const parsed =
        provider === 'twogis' ? parseTwogis(body, traffic) : parseYandex(body, traffic);
      if (!parsed.route) return { route: null, failure: parsed.failure };
      const now = this.now();
      return {
        route: {
          ...parsed.route,
          provider,
          observedAt: now,
          expiresAt: now + (parsed.route.traffic ? FRESH_TRAFFIC_SEC : FRESH_ROUTE_SEC),
          cacheState: 'live',
        },
        failure: null,
      };
    } catch (error) {
      return {
        route: null,
        failure: signal.aborted
          ? 'timeout'
          : error instanceof SyntaxError
            ? 'invalid_response'
            : 'network',
      };
    }
  }
}

type ParsedRoute = {
  points: MapPoint[];
  distanceKm: number;
  durationSec: number;
  traffic: boolean;
};
type Parsed = { route: ParsedRoute | null; failure: MapFailure | null };
function parseTwogis(body: unknown, traffic: boolean): Parsed {
  const payload = record(body);
  if (
    payload.status === 'ROUTE_NOT_FOUND' ||
    payload.status === 'ROUTE_DOES_NOT_EXISTS' ||
    payload.status === 'POINT_EXCLUDED' ||
    payload.status === 'ATTRACT_FAIL'
  )
    return { route: null, failure: 'no_route' };
  if (payload.status !== 'OK' || !Array.isArray(payload.result))
    return { route: null, failure: 'invalid_response' };
  const first = record(payload.result[0]);
  const points = geometry(record(first.begin_pedestrian_path).geometry);
  for (const maneuver of Array.isArray(first.maneuvers) ? first.maneuvers : []) {
    points.push(...geometry(record(record(maneuver).outcoming_path).geometry));
  }
  points.push(...geometry(record(first.end_pedestrian_path).geometry));
  const query = record(payload.query);
  return parsed(
    points,
    first.total_distance,
    first.total_duration,
    traffic && query.traffic_mode === 'jam' && query.transport === 'driving',
  );
}
function parseYandex(body: unknown, traffic: boolean): Parsed {
  const route = record(record(body).route);
  const points: MapPoint[] = [];
  for (const leg of Array.isArray(route.legs) ? route.legs : []) {
    const steps = record(leg).steps;
    for (const step of Array.isArray(steps) ? steps : []) {
      const raw = record(record(step).polyline).points;
      // Yandex route step coordinates use [lat, lon], never a geographic heuristic.
      if (Array.isArray(raw))
        for (const item of raw) {
          if (Array.isArray(item) && typeof item[0] === 'number' && typeof item[1] === 'number')
            points.push({ lat: item[0], lon: item[1] });
        }
    }
  }
  if (points.length < 2 && typeof route.encodedCoordinates === 'string')
    points.push(...decodePolyline(route.encodedCoordinates));
  return parsed(points, record(route.distance).value, record(route.duration).value, traffic);
}
function parsed(
  points: MapPoint[],
  distance: unknown,
  duration: unknown,
  traffic: boolean,
): Parsed {
  points = points.filter(
    (point, index) =>
      !index || point.lat !== points[index - 1]?.lat || point.lon !== points[index - 1]?.lon,
  );
  if (
    points.length < 2 ||
    points.some((point) => !validPoint(point)) ||
    typeof distance !== 'number' ||
    !Number.isFinite(distance) ||
    distance < 0 ||
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration < 0
  )
    return { route: null, failure: 'invalid_response' };
  return {
    route: {
      points: points.filter(
        (point, index) =>
          !index || point.lat !== points[index - 1]?.lat || point.lon !== points[index - 1]?.lon,
      ),
      distanceKm: distance / 1000,
      durationSec: Math.ceil(duration),
      traffic,
    },
    failure: null,
  };
}
function geometry(value: unknown): MapPoint[] {
  if (Array.isArray(value)) return value.flatMap(geometry);
  const selection = record(value).selection;
  if (typeof selection !== 'string') return [];
  const match = /^LINESTRING(?: Z)?\s*\(([^)]+)\)$/i.exec(selection.trim());
  if (!match?.[1]) return [];
  return match[1].split(',').map((pair) => {
    const [lon = NaN, lat = NaN] = pair.trim().split(/\s+/).map(Number);
    return { lat, lon };
  });
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function validPoint(point: MapPoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Math.abs(point.lat) <= 90 &&
    Number.isFinite(point.lon) &&
    Math.abs(point.lon) <= 180
  );
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
