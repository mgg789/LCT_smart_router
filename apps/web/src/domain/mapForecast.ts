import type { PlanRouteView } from '../api/types';
import { formatClock } from '../lib/time';

/** Manual archival times remain hidden unless a complete map forecast supplied new ETA. */
export function routeTimingUnverified(
  route: PlanRouteView | null | undefined,
  origin?: string,
): boolean {
  return (
    route?.timingStatus === 'unverified' ||
    (origin === 'manual' && route?.timingStatus !== 'forecast')
  );
}

/** Compact provenance for the existing plan/engineer labels, including stale and fallback states. */
export function mapForecastLabel(route: PlanRouteView | null | undefined): string | null {
  const forecast = route?.mapForecast;
  if (!forecast) return null;
  if (forecast.state === 'fallback')
    return forecast.warnings.includes('no_route')
      ? 'Карты: проезд не найден · ETA не подтверждён'
      : 'Карты недоступны · резервная оценка Router';
  const provider = route?.legs.some((leg) => leg.geometryProvider === 'twogis') ? '2ГИС' : 'Карты';
  const time = forecast.observedAt === null ? '' : ` на ${formatClock(forecast.observedAt)}`;
  const mode = route?.legs.some((leg) => leg.mapObservation?.trafficMode === 'current')
    ? 'пробки'
    : 'прогноз';
  const state =
    forecast.state === 'stale'
      ? ' · устаревший кэш'
      : forecast.state === 'mixed'
        ? ' · часть пути оценена'
        : '';
  const warning = forecast.warnings.some(
    (item) => item.startsWith('window_exceeded:') || item === 'shift_exceeded',
  )
    ? ' · риск опоздания'
    : '';
  return `${provider}: ${mode}${time}${state}${warning}`;
}
