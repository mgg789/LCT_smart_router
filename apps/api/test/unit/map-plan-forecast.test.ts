import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlanRouteView } from '../../src/api/plan-view';
import {
  type ForecastRequest,
  forecastMovements,
  projectMapForecast,
} from '../../src/orchestrator/settings/map-plan-forecast';
import type { MapQuote } from '../../src/orchestrator/settings/map-routing-client';

const route: PlanRouteView = {
  engineerId: 'e',
  startLat: 55,
  startLon: 37,
  startAt: 100,
  finishAt: 500,
  timingStatus: 'calculated',
  distanceKm: 2,
  travelTimeSec: 200,
  workTimeSec: 200,
  waitingTimeSec: 0,
  lunchTimeSec: 0,
  assignedCount: 2,
  lunchStatus: 'disabled',
  stops: [
    {
      sequence: 0,
      kind: 'job',
      requestId: 'a',
      lat: 55.1,
      lon: 37.1,
      arrivalAt: 200,
      startAt: 200,
      endAt: 300,
    },
    {
      sequence: 1,
      kind: 'job',
      requestId: 'b',
      lat: 55.2,
      lon: 37.2,
      arrivalAt: 400,
      startAt: 400,
      endAt: 500,
    },
  ],
  legs: [0, 1].map((i) => ({
    legId: `leg${i}`,
    fromStopId: i ? 'e:0' : null,
    toStopId: `e:${i}`,
    departureAt: 100 + i * 200,
    arrivalAt: 200 + i * 200,
    travelTimeSec: 100,
    distanceKm: 1,
    travelSource: 'road_matrix',
    trafficFactor: 1,
    geometry: null,
  })),
};
function requests(): Map<string, ForecastRequest> {
  return new Map(
    ['a', 'b'].map((id) => [
      id,
      {
        id,
        windowStartAt: 100,
        windowEndAt: 1000,
        serviceDurationSec: 100,
        lifecycle: 'submitted',
        startedAt: null,
        completedAt: null,
        expectedCompletionAt: null,
        assumedCompleted: false,
        pinnedStartAt: null,
      },
    ]),
  );
}
function quote(durationSec: number): MapQuote {
  return {
    failure: null,
    route: {
      provider: 'twogis',
      points: [
        { lat: 55, lon: 37 },
        { lat: 55.1, lon: 37.1 },
      ],
      distanceKm: 0.5,
      durationSec,
      traffic: true,
      observedAt: 50,
      expiresAt: 350,
      cacheState: 'cached',
    },
  };
}
describe('coherent fixed-order map forecast', () => {
  it('rebuilds arrival/start/end and aggregate metrics, consuming available waiting slack', () => {
    const rows = requests();
    rows.set('b', { ...must(rows.get('b')), windowStartAt: 400 });
    const result = projectMapForecast(route, rows, [quote(40), quote(50)], 'car', 100, 900);
    assert.deepEqual(
      result.stops.map((s) => [s.arrivalAt, s.startAt, s.endAt]),
      [
        [140, 140, 240],
        [290, 400, 500],
      ],
    );
    assert.equal(result.travelTimeSec, 90);
    assert.equal(result.waitingTimeSec, 110);
    assert.equal(result.distanceKm, 1);
    assert.ok(result.legs.every((l) => l.arrivalAt - l.departureAt === l.travelTimeSec));
    assert.equal(result.timingStatus, 'forecast');
    assert.equal(result.mapForecast?.observedAt, 50);
    assert.equal(route.travelTimeSec, 200, 'original plan is immutable');
  });
  it('reports window/shift violations without moving or removing jobs', () => {
    const result = projectMapForecast(
      route,
      requests(),
      [quote(600), quote(600)],
      'car',
      100,
      1200,
    );
    assert.deepEqual(
      result.stops.map((s) => s.requestId),
      ['a', 'b'],
    );
    assert.ok(result.mapForecast?.warnings.includes('window_exceeded:b'));
    assert.ok(result.mapForecast?.warnings.includes('shift_exceeded'));
  });
  it('anchors remaining ETA to confirmed work while preserving factual timestamps', () => {
    const rows = requests();
    rows.set('a', {
      ...must(rows.get('a')),
      lifecycle: 'completed',
      startedAt: 180,
      completedAt: 310,
    });
    const result = projectMapForecast(route, rows, [quote(999), quote(40)], 'car', 100, 900);
    assert.equal(result.stops[0]?.startAt, 180);
    assert.equal(result.stops[0]?.endAt, 310);
    assert.equal(result.stops[1]?.arrivalAt, 350);
    assert.equal(rows.get('a')?.completedAt, 310);
    assert.equal(result.legs[0], route.legs[0]);
  });
  it('supports a manual queue with no old legs and does not sort it by archival times', () => {
    const manual = {
      ...route,
      timingStatus: 'unverified' as const,
      legs: [],
      stops: [
        { ...must(route.stops[1]), sequence: 0 },
        { ...must(route.stops[0]), sequence: 1 },
      ],
    };
    const result = projectMapForecast(manual, requests(), [quote(40), quote(50)], 'car', 100, 900);
    assert.deepEqual(
      result.stops.map((s) => s.requestId),
      ['b', 'a'],
    );
    assert.deepEqual(
      result.stops.map((s) => s.startAt),
      [140, 290],
    );
    assert.equal(result.legs.length, 2);
    assert.equal(result.timingStatus, 'forecast');
  });
  it('preserves explicit NoRoute as unverified, including when all API calls fail', () => {
    const result = projectMapForecast(
      route,
      requests(),
      [
        { route: null, failure: 'no_route' },
        { route: null, failure: 'network' },
      ],
      'car',
      100,
      900,
    );
    assert.equal(result.timingStatus, 'unverified');
    assert.equal(result.mapForecast?.state, 'fallback');
  });
  it('uses stop identities when multiple stops share the same arrival timestamp', () => {
    const equal = { ...route, stops: route.stops.map((s) => ({ ...s, arrivalAt: 200 })) };
    const moves = forecastMovements(equal, requests());
    assert.equal(moves[1]?.to.lat, 55.2);
    assert.equal(moves[1]?.original?.legId, 'leg1');
  });
  it('recalculates explicit waiting instead of adding the old waiting duration again', () => {
    const waiting = {
      ...route,
      stops: [
        { ...must(route.stops[0]), kind: 'wait', requestId: null, endAt: 400 },
        { ...must(route.stops[1]), lat: 55.1, lon: 37.1, startAt: 400, endAt: 500 },
      ],
      legs: [must(route.legs[0])],
    };
    const result = projectMapForecast(
      waiting,
      requests(),
      [quote(40), { route: null, failure: null }],
      'car',
      100,
      900,
    );
    assert.equal(result.waitingTimeSec, 260);
    assert.equal(result.stops[1]?.startAt, 400);
  });
});

function must<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
