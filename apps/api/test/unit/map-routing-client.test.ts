import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MapRoutingClient } from '../../src/orchestrator/settings/map-routing-client';

const from = { lat: 55.7, lon: 37.6 };
const to = { lat: 55.74, lon: 37.64 };
const keys = { twogisApiKey: 'private-test-key', yandexApiKey: null };
const payload = {
  status: 'OK',
  query: { transport: 'driving', traffic_mode: 'jam' },
  result: [
    {
      total_distance: 1250,
      total_duration: 240,
      maneuvers: [
        { outcoming_path: { geometry: [{ selection: 'LINESTRING(37.6 55.7, 37.64 55.74)' }] } },
      ],
    },
  ],
};

describe('map provider cache and failure policy', () => {
  it('uses the same fallback provider in cache-only LIVE reads and network-enabled reads', async () => {
    const client = new MapRoutingClient(async (input) =>
      new URL(String(input)).hostname === 'routing.api.2gis.com'
        ? new Response('', { status: 503 })
        : Response.json({
            route: {
              distance: { value: 500 },
              duration: { value: 90 },
              legs: [
                {
                  steps: [
                    {
                      polyline: {
                        points: [
                          [55.7, 37.6],
                          [55.74, 37.64],
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          }),
    );
    const both = { ...keys, yandexApiKey: 'fallback-test-key' };
    const live = await client.quote(from, to, true, 'car', both);
    const cached = client.peek(from, to, true, 'car', both);
    assert.equal(live.route?.provider, 'yandex');
    assert.equal(cached.route?.provider, 'yandex');
    assert.equal(cached.route?.durationSec, live.route?.durationSec);
  });
  it('bounds a provider that never responds with an explicit timeout', async () => {
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const client = new MapRoutingClient(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const started = Date.now();
      const result = await client.quote(from, to, true, 'car', keys);
      assert.equal(result.failure, 'timeout');
      assert.ok(Date.now() - started >= 4900);
      assert.ok(Date.now() - started < 10000);
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('keeps opposite directions separate and avoids unnecessary fallback calls', async () => {
    const urls: string[] = [];
    const client = new MapRoutingClient(async (input) => {
      urls.push(String(input));
      return Response.json(payload);
    });
    await client.quote(from, to, true, 'car', { ...keys, yandexApiKey: 'unused-fallback' });
    await client.quote(to, from, true, 'car', { ...keys, yandexApiKey: 'unused-fallback' });
    assert.equal(urls.length, 2);
    assert.ok(urls.every((url) => new URL(url).hostname === 'routing.api.2gis.com'));
  });
  it('enforces the real demo-key limit of five routes per rolling minute', async () => {
    let now = 1000;
    let count = 0;
    const client = new MapRoutingClient(
      async () => {
        count++;
        return Response.json(payload);
      },
      () => now,
    );
    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        client.quote(from, { ...to, lon: to.lon + index / 1000 }, true, 'car', keys),
      ),
    );
    assert.equal(count, 5);
    assert.equal(results.filter((result) => result.failure === 'rate_limit').length, 4);
    now = 1061;
    await client.quote(from, { ...to, lon: 38 }, true, 'car', keys);
    assert.equal(count, 6);
  });
  it('coalesces concurrent calls and expires traffic observations after five minutes', async () => {
    let now = 1000;
    let count = 0;
    const client = new MapRoutingClient(
      async () => {
        count++;
        return Response.json(payload);
      },
      () => now,
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => client.quote(from, to, true, 'car', keys)),
    );
    assert.equal(count, 1);
    assert.equal(results[0]?.route?.observedAt, 1000);
    now = 1299;
    assert.equal((await client.quote(from, to, true, 'car', keys)).route?.cacheState, 'cached');
    assert.equal(count, 1);
    now = 1300;
    assert.equal((await client.quote(from, to, true, 'car', keys)).route?.observedAt, 1300);
    assert.equal(count, 2);
  });

  it('isolates cache, failures and diagnostics across a key rotation', async () => {
    let count = 0;
    const client = new MapRoutingClient(async () => {
      count++;
      return Response.json(payload);
    });
    await client.quote(from, to, true, 'car', keys);
    await client.quote(from, to, true, 'car', { ...keys, twogisApiKey: 'rotated-key' });
    assert.equal(count, 2);
    const status = client.status('twogis', 'rotated-key');
    assert.equal(status.requests, 1);
    assert.equal(JSON.stringify(status).includes('key'), false);
  });

  it('health reads do not make synthetic paid calls', () => {
    let count = 0;
    const client = new MapRoutingClient(async () => {
      count++;
      return Response.json(payload);
    });
    assert.equal(client.status('twogis', keys.twogisApiKey).code, 'not_checked');
    assert.equal(client.status('yandex', null).code, 'not_configured');
    assert.equal(count, 0);
  });

  for (const [status, code] of [
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'quota'],
    [500, 'unavailable'],
  ] as const) {
    it(`backs off ${status} for all legs instead of burning quota`, async () => {
      let count = 0;
      const client = new MapRoutingClient(async () => {
        count++;
        return new Response('secret must not escape', { status });
      });
      assert.equal((await client.quote(from, to, true, 'car', keys)).failure, code);
      assert.equal((await client.quote(to, from, true, 'car', keys)).failure, code);
      assert.equal(count, 1);
      assert.equal(client.status('twogis', keys.twogisApiKey).code, code);
    });
  }

  it('does not replace a confirmed NoRoute with stale data or another provider', async () => {
    let now = 0;
    let count = 0;
    const client = new MapRoutingClient(
      async () => {
        count++;
        return Response.json(count === 1 ? payload : { status: 'ROUTE_NOT_FOUND' });
      },
      () => now,
    );
    const both = { ...keys, yandexApiKey: 'unused-yandex' };
    await client.quote(from, to, true, 'car', both);
    now = 301;
    const result = await client.quote(from, to, true, 'car', both);
    assert.equal(result.failure, 'no_route');
    assert.equal(result.route, null);
    assert.equal(count, 2);
  });

  it('marks an old observation stale during outage, and bounds its lifetime', async () => {
    let now = 0;
    const client = new MapRoutingClient(
      async () => {
        if (now) throw new Error('secret URL');
        return Response.json(payload);
      },
      () => now,
    );
    await client.quote(from, to, true, 'car', keys);
    now = 301;
    const stale = await client.quote(from, to, true, 'car', keys);
    assert.equal(stale.failure, 'network');
    assert.equal(stale.route?.cacheState, 'stale');
    assert.equal(stale.route?.observedAt, 0);
    now = 3601;
    assert.equal((await client.quote(from, to, true, 'car', keys)).route, null);
  });

  it('uses the requested profile, never car traffic for a walker or cyclist', async () => {
    const bodies: unknown[] = [];
    const client = new MapRoutingClient(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json({ ...payload, query: body });
    });
    assert.equal((await client.quote(from, to, true, 'walk', keys)).route?.traffic, false);
    assert.equal((await client.quote(from, to, true, 'bike', keys)).route?.traffic, false);
    assert.equal(
      (await client.quote(from, to, true, 'transit', keys)).failure,
      'unsupported_transport',
    );
    assert.equal(bodies.length, 2);
    assert.deepEqual(
      bodies.map((body) => (body as { transport: string }).transport),
      ['walking', 'bicycle'],
    );
  });

  it('requires valid geometry and finite metrics, and trusts echoed traffic mode', async () => {
    for (const body of [
      { ...payload, result: [{ ...payload.result[0], total_duration: -1 }] },
      { ...payload, result: [{ ...payload.result[0], total_distance: '1250' }] },
      { ...payload, result: [{ ...payload.result[0], maneuvers: [] }] },
    ]) {
      const client = new MapRoutingClient(async () => Response.json(body));
      assert.equal((await client.quote(from, to, true, 'car', keys)).failure, 'invalid_response');
    }
    const client = new MapRoutingClient(async () =>
      Response.json({ ...payload, query: { traffic_mode: 'statistics' } }),
    );
    assert.equal((await client.quote(from, to, true, 'car', keys)).route?.traffic, false);
  });
});
