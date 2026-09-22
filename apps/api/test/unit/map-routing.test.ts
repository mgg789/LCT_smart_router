import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { PlanRouteSegmentView, PlanView } from '../../src/api/plan-view';
import { DEFAULT_DISPATCHER_SETTINGS } from '../../src/orchestrator/settings/dispatcher-settings';
import { MapRoutingService } from '../../src/orchestrator/settings/map-routing.service';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const a = { lat: 55.72, lon: 37.75 };
const b = { lat: 55.73, lon: 37.75 };
const c = { lat: 55.75, lon: 37.65 };
const d = { lat: 55.76, lon: 37.65 };

function service(provider: 'twogis' | 'yandex' = 'twogis') {
  return new MapRoutingService({
    read: async () => ({
      ...DEFAULT_DISPATCHER_SETTINGS,
      twogisApiKey: provider === 'twogis' ? 'test-key' : null,
      yandexApiKey: provider === 'yandex' ? 'test-key' : null,
    }),
  });
}

function plan(segments: PlanRouteSegmentView[]): PlanView {
  return {
    revision: 1,
    origin: 'auto',
    planAsOf: 100,
    appliedAt: 100,
    assignments: [],
    routes: [
      {
        engineerId: 'walker',
        startLat: a.lat,
        startLon: a.lon,
        startAt: 100,
        finishAt: 1500,
        distanceKm: 7,
        travelTimeSec: 1400,
        workTimeSec: 0,
        waitingTimeSec: 0,
        lunchTimeSec: 0,
        assignedCount: 1,
        lunchStatus: 'disabled',
        stops: [],
        legs: [
          {
            legId: 'leg',
            fromStopId: null,
            toStopId: 'stop',
            departureAt: 100,
            arrivalAt: 1500,
            travelTimeSec: 1400,
            distanceKm: 7,
            geometry: { points: [a, b, c, d] },
            travelSource: 'metro',
            trafficFactor: 1,
            segments,
          },
        ],
      },
    ],
  };
}

describe('map routing transport and composite geometry', () => {
  it('skips paid providers below 300 metres even when configured', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('Must not call');
    };
    assert.equal(await service().route(a, { lat: a.lat + 0.001, lon: a.lon }, true), null);
    assert.equal(calls, 0);
  });

  it('selects transport-specific 2GIS modes and separates their caches', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        result: [
          {
            total_distance: 1000,
            total_duration: 900,
            maneuvers: [
              {
                outcoming_path: {
                  geometry: [{ selection: 'LINESTRING(37.75 55.72,37.75 55.73)' }],
                },
              },
            ],
          },
        ],
      });
    };
    const router = service();
    for (const transport of ['walk', 'bike', 'car', 'walk'] as const) {
      const result = await router.route(a, b, true, transport);
      assert.deepEqual(result?.points, [a, b]);
      assert.equal(result?.traffic, transport === 'car');
    }
    assert.deepEqual(
      bodies.map((body) => body.transport),
      ['walking', 'bicycle', 'driving'],
    );
    assert.equal(bodies[0]?.traffic_mode, undefined);
    assert.equal(bodies[2]?.traffic_mode, 'jam');
  });

  it('uses walking and bicycle Yandex modes without driving traffic', async () => {
    const urls: URL[] = [];
    globalThis.fetch = async (input) => {
      urls.push(new URL(String(input)));
      return Response.json({ route: { legs: [{ steps: [{ polyline: { points: [a, b] } }] }] } });
    };
    const router = service('yandex');
    await router.route(a, b, true, 'walk');
    await router.route(a, b, true, 'bike');
    assert.deepEqual(
      urls.map((url) => url.searchParams.get('mode')),
      ['walking', 'bicycle'],
    );
    assert.ok(urls.every((url) => !url.searchParams.has('traffic')));
  });

  it('enriches only walking access/egress and preserves accepted costs and purple metro', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.transport);
      const [from, to] = body.points;
      return Response.json({
        result: [
          {
            total_distance: 99999,
            total_duration: 99999,
            geometry: { selection: `LINESTRING(${from.lon} ${from.lat},${to.lon} ${to.lat})` },
          },
        ],
      });
    };
    const segments: PlanRouteSegmentView[] = [
      {
        geometry: { points: [a, b] },
        travelSource: 'approximate',
        travelTimeSec: 300,
        distanceKm: 1,
      },
      { geometry: { points: [b, c] }, travelSource: 'metro', travelTimeSec: 800, distanceKm: 5 },
      {
        geometry: { points: [c, d] },
        travelSource: 'road_matrix',
        travelTimeSec: 300,
        distanceKm: 1,
      },
    ];
    const result = await service().enrichPlan(plan(segments), true, new Map([['walker', 'walk']]));
    const leg = result.routes[0]?.legs[0];
    assert.deepEqual(calls, ['walking', 'walking']);
    assert.deepEqual(leg?.segments?.[1], segments[1]);
    assert.equal(leg?.segments?.[0]?.geometryProvider, 'twogis');
    assert.equal(leg?.segments?.[0]?.travelSource, 'approximate');
    assert.equal(leg?.travelTimeSec, 1400);
    assert.equal(leg?.distanceKm, 7);
    assert.equal(leg?.arrivalAt, 1500);
    assert.deepEqual(leg?.geometry?.points, [a, b, c, d]);
  });

  it('draws an MKAD road polyline for a straight chord and leaves an outside pair dashed', async () => {
    const previous = process.env.ROUTER_ROAD_API_URL;
    process.env.ROUTER_ROAD_API_URL = 'http://road.test';
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      const start = url.searchParams.get('a') ?? '';
      if (start.startsWith('55.75')) {
        return Response.json({ mode: 'straight', geometry: [[c.lat, c.lon], [d.lat, d.lon]] });
      }
      return Response.json({
        mode: 'road',
        geometry: [
          [a.lat, a.lon],
          [55.725, 37.751],
          [b.lat, b.lon],
        ],
      });
    };
    const segments: PlanRouteSegmentView[] = [
      {
        geometry: { points: [a, b] },
        travelSource: 'approximate',
        travelTimeSec: 300,
        distanceKm: 1,
      },
      { geometry: { points: [b, c] }, travelSource: 'metro', travelTimeSec: 800, distanceKm: 5 },
      {
        geometry: { points: [c, d] },
        travelSource: 'approximate',
        travelTimeSec: 300,
        distanceKm: 1,
      },
    ];
    try {
      const result = await new MapRoutingService({
        read: async () => DEFAULT_DISPATCHER_SETTINGS,
      }).enrichPlan(plan(segments), false, new Map());
      const leg = result.routes[0]?.legs[0];
      assert.equal(leg?.segments?.[0]?.travelSource, 'traffic_api');
      assert.equal(leg?.segments?.[0]?.travelTimeSec, 300);
      assert.ok((leg?.segments?.[0]?.geometry.points.length ?? 0) >= 3);
      assert.deepEqual(leg?.segments?.[1], segments[1]);
      assert.equal(leg?.segments?.[2]?.travelSource, 'approximate');
      assert.equal(leg?.travelTimeSec, 1400);
    } finally {
      if (previous === undefined) delete process.env.ROUTER_ROAD_API_URL;
      else process.env.ROUTER_ROAD_API_URL = previous;
    }
  });

  it('keeps the chord when the road API is not configured', async () => {
    const previous = process.env.ROUTER_ROAD_API_URL;
    delete process.env.ROUTER_ROAD_API_URL;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('Must not call');
    };
    const segments: PlanRouteSegmentView[] = [
      {
        geometry: { points: [a, b] },
        travelSource: 'approximate',
        travelTimeSec: 300,
        distanceKm: 1,
      },
    ];
    try {
      const result = await new MapRoutingService({
        read: async () => DEFAULT_DISPATCHER_SETTINGS,
      }).enrichPlan(plan(segments), false, new Map());
      assert.equal(calls, 0);
      assert.equal(result.routes[0]?.legs[0]?.segments?.[0]?.travelSource, 'approximate');
    } finally {
      if (previous === undefined) delete process.env.ROUTER_ROAD_API_URL;
      else process.env.ROUTER_ROAD_API_URL = previous;
    }
  });
});
