import type { RouterWeather } from '../routing/router-gateway';

/** Dispatcher and engineer apps share one Moscow forecast shape. */
export function weatherView(forecast: RouterWeather | null): {
  observedAt: number;
  temperatureC: number | null;
  weatherCode: number | null;
  kind: RouterWeather['kind'];
  label: string;
  trafficMultiplier: number;
} {
  if (!forecast) {
    return {
      observedAt: 0,
      temperatureC: null,
      weatherCode: null,
      kind: 'unknown',
      label: 'Нет прогноза',
      trafficMultiplier: 1,
    };
  }
  return {
    observedAt: forecast.observed_at,
    temperatureC: forecast.temperature_c,
    weatherCode: forecast.weather_code,
    kind: forecast.kind,
    label: forecast.label,
    trafficMultiplier: forecast.traffic_multiplier,
  };
}
