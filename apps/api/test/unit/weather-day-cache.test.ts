import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WeatherDayCacheService,
  weatherLocationHash,
} from '../../src/orchestrator/ai/weather-day-cache.service';
import type { PrismaService } from '../../src/persistence';

/** Minimal transaction fixture preserves the service's generation boundary. */
function mockDatabase(
  input: {
    weatherDayCache: {
      findMany: (query?: unknown) => Promise<Array<{ workDate: string }>>;
      upsert: (value: unknown) => Promise<unknown>;
    };
  },
  generation: () => number = () => 1,
): PrismaService {
  const database = {
    ...input,
    appState: { findUnique: async () => ({ value: generation() }) },
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    $transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation(database),
  };
  return database as unknown as PrismaService;
}

test('weather archive failures preserve offline operation and can be retried', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const writes: unknown[] = [];
  const service = new WeatherDayCacheService(
    mockDatabase({
      weatherDayCache: {
        findMany: async () => [],
        upsert: async (value: unknown) => {
          writes.push(value);
        },
      },
    }),
  );
  try {
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('offline');
    };
    await service.fillMissing('east', 55.75, 37.7, ['2026-09-20']);
    assert.deepEqual(writes, []);
    globalThis.fetch = async (input, init) => {
      calls += 1;
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://archive-api.open-meteo.com');
      assert.equal(url.searchParams.get('timezone'), 'Europe/Moscow');
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      return new Response(JSON.stringify({ daily: { time: ['2026-09-20'], weather_code: [61] } }));
    };
    await service.fillMissing('east', 55.75, 37.7, ['2026-09-20']);
    assert.equal(calls, 2);
    assert.equal(writes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unknown weather codes cannot contaminate the clear-day reference', async () => {
  const originalFetch = globalThis.fetch;
  const writes: unknown[] = [];
  const service = new WeatherDayCacheService(
    mockDatabase({
      weatherDayCache: {
        findMany: async () => [],
        upsert: async (value: unknown) => {
          writes.push(value);
        },
      },
    }),
  );
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          daily: {
            time: ['2026-09-20', '2026-09-21', '2026-09-22'],
            weather_code: [999, null, 0],
          },
        }),
      );
    await service.fillMissing('east', 55.75, 37.7, ['2026-09-20', '2026-09-21']);
    assert.deepEqual(writes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('persisted region/day weather requires no network on replay', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const service = new WeatherDayCacheService(
    mockDatabase({
      weatherDayCache: {
        findMany: async () => [{ workDate: '2026-09-20' }],
        upsert: async () => {
          throw new Error('unexpected write');
        },
      },
    }),
  );
  try {
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error('unexpected network');
    };
    await service.fillMissing('east', 55.75, 37.7, ['2026-09-20', '2026-09-20']);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('archive responses started before reset cannot repopulate cleared evidence', async () => {
  const originalFetch = globalThis.fetch;
  let generation = 1;
  const writes: unknown[] = [];
  const service = new WeatherDayCacheService(
    mockDatabase(
      {
        weatherDayCache: {
          findMany: async () => [],
          upsert: async (value) => {
            writes.push(value);
          },
        },
      },
      () => generation,
    ),
  );
  try {
    globalThis.fetch = async () => {
      generation = 2;
      return new Response(JSON.stringify({ daily: { time: ['2026-09-20'], weather_code: [61] } }));
    };
    await service.fillMissing('east', 55.75, 37.7, ['2026-09-20']);
    assert.deepEqual(writes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cache lookup binds coordinates and an offline refresh cannot reuse another location', async () => {
  const originalFetch = globalThis.fetch;
  const queries: unknown[] = [];
  const writes: unknown[] = [];
  const service = new WeatherDayCacheService(
    mockDatabase({
      weatherDayCache: {
        findMany: async (query) => {
          queries.push(query);
          return [];
        },
        upsert: async (value) => {
          writes.push(value);
        },
      },
    }),
  );
  try {
    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    await service.fillMissing('east', 55.76, 37.8, ['2026-09-20']);
    assert.deepEqual(queries, [
      {
        where: {
          region: 'east',
          workDate: { in: ['2026-09-20'] },
          locationHash: weatherLocationHash(55.76, 37.8),
        },
        select: { workDate: true },
      },
    ]);
    assert.deepEqual(writes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
