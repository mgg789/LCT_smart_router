import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfigService } from '../../src/common/config';
import { AiService } from '../../src/orchestrator/ai/ai.service';
import type { WeatherDayCacheService } from '../../src/orchestrator/ai/weather-day-cache.service';
import { APP_STATE_KEYS, type PrismaService } from '../../src/persistence';
import type { RouterClient } from '../../src/routing/router-gateway';

type CalibrationFact = {
  id: string;
  requestId: string;
  engineerId: string | null;
  kind: string;
  occurredAt: bigint;
  metadata: unknown;
};

type CalibrationRequest = {
  id: string;
  serviceDurationSec: number;
  lat: number | null;
  lon: number | null;
  lifecycle: string;
  origin: 'import' | 'manual' | 'system_rule' | 'synthesized';
};

function fixture(
  input: {
    facts?: CalibrationFact[];
    requests?: CalibrationRequest[];
    cache?: Record<string, unknown>;
  } = {},
) {
  let enabled = false;
  const database = {
    appState: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (where.key === APP_STATE_KEYS.GENERATION) return { value: 4 };
        if (where.key === APP_STATE_KEYS.AI_CALIBRATION)
          return input.cache ? { value: input.cache } : null;
        return { value: { planCalibrationEnabled: enabled } };
      },
    },
    requestFact: {
      findMany: async () => input.facts ?? [],
      count: async () => (input.facts ?? []).length,
    },
    request: {
      findMany: async () => input.requests ?? [],
      count: async ({ where }: { where: { lifecycle?: unknown } }) => {
        const requests = input.requests ?? [];
        if (typeof where.lifecycle === 'string') {
          return requests.filter(
            (request) => request.origin !== 'synthesized' && request.lifecycle === where.lifecycle,
          ).length;
        }
        return requests.filter(
          (request) =>
            request.origin !== 'synthesized' &&
            (request.lifecycle === 'completed' || request.lifecycle === 'cancelled'),
        ).length;
      },
    },
    depot: { findMany: async () => [] },
    weatherDayCache: { findMany: async () => [] },
    weatherRiskPrediction: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    engineerDay: { findMany: async () => [] },
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(database),
  };
  const router = {
    getPredictCalibration: () => {
      throw new Error('optional calibration API unavailable');
    },
    updatePredictCalibration: () => {
      throw new Error('offline');
    },
  };
  const service = new AiService(
    database as unknown as PrismaService,
    router as unknown as RouterClient,
    { isProduction: true, get: () => undefined } as unknown as AppConfigService,
    {} as WeatherDayCacheService,
  );
  return {
    service,
    enable: () => {
      enabled = true;
    },
  };
}

test('a committed disable forces factory on the next prediction before asynchronous refresh', async () => {
  const { service, enable } = fixture();
  const override = await service.predictionCalibrationOverride(4);
  assert.equal(override?.source, 'factory');
  assert.equal(override?.working_set_generation, 4);
  assert.deepEqual(override?.weather_multipliers, []);
  assert.equal(await service.weatherShadowOverride(), null);
  enable();
  assert.equal(await service.predictionCalibrationOverride(4), null);
});

test('offline rollback tolerates synchronous optional-client errors and retains factory request override', async () => {
  const { service } = fixture();
  assert.equal(await service.rollbackToFactory(), false);
  assert.equal((await service.predictionCalibrationOverride(4))?.source, 'factory');
});

test('planned imported requests do not increase calibration coverage without execution facts', async () => {
  const { service } = fixture({
    requests: Array.from({ length: 15 }, (_, index) => ({
      id: `planned-${index}`,
      serviceDurationSec: 1_800,
      lat: null,
      lon: null,
      lifecycle: 'submitted',
      origin: 'import',
    })),
  });
  const computed = await (
    service as unknown as {
      computeFromFacts: (
        previous: null,
        signature: string,
      ) => Promise<{
        confidence: number;
        samples: { cancelRequests: number };
        calibration: { source: string };
      }>;
    }
  ).computeFromFacts(null, '4:0:0:0:weather:risk');

  assert.equal(computed.confidence, 0);
  assert.equal(computed.samples.cancelRequests, 0);
  assert.equal(computed.calibration.source, 'factory');
});

test('synthetic terminal rows do not count as measured cancellation coverage', async () => {
  const { service } = fixture({
    requests: [
      {
        id: 'synthetic-completed',
        serviceDurationSec: 1_800,
        lat: null,
        lon: null,
        lifecycle: 'completed',
        origin: 'synthesized',
      },
      {
        id: 'real-cancelled',
        serviceDurationSec: 1_800,
        lat: null,
        lon: null,
        lifecycle: 'cancelled',
        origin: 'manual',
      },
    ],
  });
  const computed = await (
    service as unknown as {
      computeFromFacts: (
        previous: null,
        signature: string,
      ) => Promise<{ samples: { cancelRequests: number } }>;
    }
  ).computeFromFacts(null, '4:0:0:0:weather:risk');

  assert.equal(computed.samples.cancelRequests, 1);
});

test('legacy millisecond computedAt values are exposed as Unix seconds', async () => {
  const { service } = fixture({
    cache: {
      calibration: { source: 'factory' },
      version: null,
      confidence: 0,
      samples: { service: 0, legs: 0, cancelRequests: 0, executionDays: 0 },
      computedAt: 1_758_000_000_000,
      weatherCalibration: {
        status: 'factory',
        observationCount: 0,
        days: 0,
        eligibleGroups: 0,
        totalGroups: 0,
        version: null,
        source: 'travel_elapsed_proxy',
        uncertainty: 'not_estimated',
        reason: 'none',
      },
      weatherCandidates: [],
      signature: 'legacy',
    },
  });

  const view = await service.present(null);
  assert.equal(view.status.computedAt, 1_758_000_000);
});

test('planned to completed transition changes the calibration signature', async () => {
  const requests: CalibrationRequest[] = [
    {
      id: 'request-1',
      serviceDurationSec: 1_800,
      lat: null,
      lon: null,
      lifecycle: 'submitted',
      origin: 'import',
    },
  ];
  const { service } = fixture({ requests });
  const dataSignature = (
    service as unknown as {
      dataSignature: () => Promise<string>;
    }
  ).dataSignature.bind(service);
  const before = await dataSignature();

  const request = requests[0];
  assert.ok(request);
  request.lifecycle = 'completed';

  const after = await dataSignature();
  assert.notEqual(after, before);
});
