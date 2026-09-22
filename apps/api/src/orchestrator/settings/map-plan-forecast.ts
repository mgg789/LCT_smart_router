import type { PlanRouteLegView, PlanRouteView, PlanStopView } from '../../api/plan-view';
import type { MapPoint, MapQuote, MapTransport } from './map-routing-client';

/** Business context is read separately; forecasts cannot write these execution facts. */
export interface ForecastRequest {
  readonly id: string;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly serviceDurationSec: number;
  readonly lifecycle: string;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly expectedCompletionAt: number | null;
  readonly assumedCompleted: boolean;
  readonly pinnedStartAt: number | null;
}
/** Coordinate pair selected by ordered stops, never by matching mutable timestamps. */
export interface ForecastMovement {
  readonly from: MapPoint;
  readonly to: MapPoint;
  readonly stop: PlanStopView;
  readonly previous: PlanStopView | null;
  readonly original: PlanRouteLegView | null;
  readonly protected: boolean;
}

/** Derive movements by stop identity/sequence, including co-located stops and manual queues. */
export function forecastMovements(
  route: PlanRouteView,
  requests: ReadonlyMap<string, ForecastRequest>,
): ForecastMovement[] {
  const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence);
  return stops.map((stop, index) => {
    const previous =
      stops
        .slice(0, index)
        .findLast(
          (item) => !item.requestId || requests.get(item.requestId)?.lifecycle !== 'cancelled',
        ) ?? null;
    const request = stop.requestId ? requests.get(stop.requestId) : undefined;
    return {
      from: previous ?? { lat: route.startLat, lon: route.startLon },
      to: stop,
      stop,
      previous,
      original:
        route.legs.find(
          (leg) =>
            leg.toStopSequence === stop.sequence ||
            leg.toStopId === `${route.engineerId}:${stop.sequence}`,
        ) ?? null,
      protected: Boolean(
        request &&
          (request.lifecycle !== 'submitted' ||
            request.startedAt !== null ||
            request.assumedCompleted ||
            request.pinnedStartAt !== null),
      ),
    };
  });
}

/** Fixed-order ETA projection. Keeps assignments/sequence, flags infeasibility, never optimizes. */
export function projectMapForecast(
  route: PlanRouteView,
  requests: ReadonlyMap<string, ForecastRequest>,
  quotes: readonly MapQuote[],
  transport: MapTransport,
  asOf: number,
  shiftEndAt: number | null,
): PlanRouteView {
  const movements = forecastMovements(route, requests);
  if (!quotes.some((quote) => quote.route)) {
    const failures = quotes.flatMap((quote) =>
      quote.failure && quote.failure !== 'not_configured' ? [quote.failure] : [],
    );
    return failures.length
      ? {
          ...route,
          ...(failures.includes('no_route') ? { timingStatus: 'unverified' as const } : {}),
          mapForecast: { observedAt: null, state: 'fallback', warnings: [...new Set(failures)] },
        }
      : route;
  }
  const warnings = new Set<string>();
  const stops: PlanStopView[] = [];
  const legs: PlanRouteLegView[] = [];
  let cursor = route.startAt ?? asOf;
  let waitingTimeSec = 0;
  let anyUnverified = false;
  let stale = false;
  let mixed = false;
  let observedAt = Number.POSITIVE_INFINITY;
  for (const [index, movement] of movements.entries()) {
    const { stop, previous, original } = movement;
    const request = stop.requestId ? requests.get(stop.requestId) : undefined;
    const quote = quotes[index];
    const mapped = movement.protected ? null : quote?.route;
    if (quote?.failure) warnings.add(quote.failure);
    if (movement.protected) {
      if (request?.lifecycle === 'cancelled') {
        stops.push(stop);
        continue;
      }
      // Completed/in-progress timestamps are factual anchors, never shifted by new traffic.
      const start = request?.startedAt ?? request?.pinnedStartAt ?? stop.startAt;
      const end =
        request?.completedAt ??
        (request?.startedAt !== null && request?.startedAt !== undefined
          ? (request.expectedCompletionAt ?? start + request.serviceDurationSec)
          : request?.pinnedStartAt !== null && request?.pinnedStartAt !== undefined
            ? start + request.serviceDurationSec
            : stop.endAt);
      stops.push({
        ...stop,
        arrivalAt: request?.startedAt ?? stop.arrivalAt,
        startAt: start,
        endAt: end,
      });
      if (original) legs.push(original);
      cursor = Math.max(cursor, end);
      continue;
    }
    const samePoint =
      movement.from.lat === movement.to.lat && movement.from.lon === movement.to.lon;
    const duration =
      quote?.failure === 'no_route'
        ? null
        : (mapped?.durationSec ?? original?.travelTimeSec ?? (samePoint ? 0 : null));
    if (duration === null) {
      // Manual queues without provider coverage have no defensible travel estimate.
      anyUnverified = true;
      warnings.add('missing_travel_time');
      stops.push(stop);
      cursor = Math.max(cursor, stop.endAt);
      continue;
    }
    if (mapped) {
      observedAt = Math.min(observedAt, mapped.observedAt);
      stale ||= mapped.cacheState === 'stale';
    } else if (!samePoint) mixed = true;
    const arrivalAt = cursor + duration;
    const startAt =
      stop.kind === 'wait'
        ? arrivalAt
        : Math.max(arrivalAt, request?.windowStartAt ?? stop.startAt);
    const endAt =
      stop.kind === 'wait'
        ? Math.max(arrivalAt, stop.endAt)
        : startAt + (request?.serviceDurationSec ?? Math.max(0, stop.endAt - stop.startAt));
    waitingTimeSec += startAt - arrivalAt + (stop.kind === 'wait' ? endAt - startAt : 0);
    if (request && endAt > request.windowEndAt) warnings.add(`window_exceeded:${request.id}`);
    const nextStop = { ...stop, arrivalAt, startAt, endAt };
    stops.push(nextStop);
    if (!samePoint || original || mapped)
      legs.push({
        legId: original?.legId ?? `map:${route.engineerId}:${stop.sequence}`,
        fromStopId: previous ? `${route.engineerId}:${previous.sequence}` : null,
        toStopId: `${route.engineerId}:${stop.sequence}`,
        departureAt: cursor,
        arrivalAt,
        travelTimeSec: duration,
        distanceKm: mapped?.distanceKm ?? original?.distanceKm ?? 0,
        geometry: mapped ? { points: [...mapped.points] } : (original?.geometry ?? null),
        travelSource: mapped
          ? mapped.traffic
            ? 'traffic_api'
            : 'route_api'
          : (original?.travelSource ?? 'approximate'),
        // A new provider duration is not a ratio against Router's differently-modelled ETA.
        trafficFactor: mapped ? 1 : (original?.trafficFactor ?? 1),
        ...(mapped
          ? {
              geometryProvider: mapped.provider,
              mapObservation: {
                observedAt: mapped.observedAt,
                expiresAt: mapped.expiresAt,
                cacheState: mapped.cacheState,
                trafficMode: mapped.traffic
                  ? ('current' as const)
                  : transport === 'car'
                    ? ('statistics' as const)
                    : ('none' as const),
              },
            }
          : {}),
      });
    cursor = endAt;
  }
  if (shiftEndAt !== null && cursor > shiftEndAt) warnings.add('shift_exceeded');
  return {
    ...route,
    timingStatus: anyUnverified ? 'unverified' : 'forecast',
    finishAt: stops.at(-1)?.endAt ?? route.finishAt,
    distanceKm: legs.reduce((sum, leg) => sum + leg.distanceKm, 0),
    travelTimeSec: legs.reduce((sum, leg) => sum + leg.travelTimeSec, 0),
    workTimeSec: stops
      .filter((stop) => stop.kind === 'job')
      .reduce((sum, stop) => sum + stop.endAt - stop.startAt, 0),
    lunchTimeSec: stops
      .filter((stop) => stop.kind === 'lunch')
      .reduce((sum, stop) => sum + stop.endAt - stop.startAt, 0),
    waitingTimeSec,
    stops,
    legs,
    mapForecast: {
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
      state: stale ? 'stale' : mixed ? 'mixed' : 'fresh',
      warnings: [...warnings],
    },
  };
}
