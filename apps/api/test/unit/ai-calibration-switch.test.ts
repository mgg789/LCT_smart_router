import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfigService } from '../../src/common/config';
import { AiService } from '../../src/orchestrator/ai/ai.service';
import type { WeatherDayCacheService } from '../../src/orchestrator/ai/weather-day-cache.service';
import { APP_STATE_KEYS, type PrismaService } from '../../src/persistence';
import type { RouterClient } from '../../src/routing/router-gateway';

function fixture() {
  let enabled = false;
  const database = {
    appState: {
      findUnique: async ({ where }: { where: { key: string } }) => ({
        value: where.key === APP_STATE_KEYS.GENERATION ? 4 : { planCalibrationEnabled: enabled },
      }),
    },
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
    { isProduction: true } as AppConfigService,
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
