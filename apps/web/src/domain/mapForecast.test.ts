import { describe, expect, it } from 'vitest';
import type { PlanRouteView } from '../api/types';
import { mapForecastLabel, routeTimingUnverified } from './mapForecast';

const route: PlanRouteView = {
  engineerId: 'e',
  startLat: 55,
  startLon: 37,
  startAt: 0,
  finishAt: 300,
  assignedCount: 0,
  workTimeSec: 0,
  lunchTimeSec: 0,
  waitingTimeSec: 0,
  distanceKm: 1,
  travelTimeSec: 300,
  lunchStatus: 'disabled',
  stops: [],
  legs: [],
  timingStatus: 'forecast',
  mapForecast: { observedAt: 1789999200, state: 'fresh', warnings: [] },
};

describe('map forecast timing admission', () => {
  it('keeps archival manual times hidden without a verified forecast', () => {
    expect(routeTimingUnverified(null, 'manual')).toBe(true);
    expect(routeTimingUnverified(null, 'auto')).toBe(false);
  });
  it('admits ETA for a manual queue only after a complete forecast, and rejects NoRoute', () => {
    expect(routeTimingUnverified(route, 'manual')).toBe(false);
    const noRoute = {
      ...route,
      timingStatus: 'unverified' as const,
      mapForecast: { observedAt: null, state: 'fallback' as const, warnings: ['no_route'] },
    };
    expect(routeTimingUnverified(noRoute, 'auto')).toBe(true);
    expect(mapForecastLabel(noRoute)).toContain('проезд не найден');
  });
  it('makes stale data and timing risks visible instead of presenting an all-clear forecast', () => {
    const stale = {
      ...route,
      mapForecast: {
        observedAt: 1789999200,
        state: 'stale' as const,
        warnings: ['window_exceeded:r'],
      },
    };
    expect(mapForecastLabel(stale)).toContain('устаревший кэш');
    expect(mapForecastLabel(stale)).toContain('риск опоздания');
  });
});
