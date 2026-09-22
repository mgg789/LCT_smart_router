import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { buildMapsDemo } from '../../scripts/maps-demo';
import { toPlanView } from '../../src/api/plan-view';
import { AppModule } from '../../src/app.module';
import type { Actor } from '../../src/auth';
import { UploadImportService } from '../../src/orchestrator/imports';
import { LiveService } from '../../src/orchestrator/live';
import { DEFAULT_DISPATCHER_SETTINGS } from '../../src/orchestrator/settings/dispatcher-settings';
import { MapRoutingService } from '../../src/orchestrator/settings/map-routing.service';
import { APP_STATE_KEYS, PrismaService, UnitOfWork } from '../../src/persistence';
import { AppliedPlanService, ManualPlanService } from '../../src/routing/router-gateway';
import { transitionControl } from '../../src/routing/router-gateway/control-transition';
import { routerResultSchema } from '../../src/routing/router-gateway/result.types';
import { unique } from '../support/database';
import { buildRouterResult } from '../support/router-result';

describe('DRO-101 real storage and shared forecast', () => {
  let app: INestApplicationContext;
  let db: PrismaService;
  let engineerId: string;
  let requestIds: string[];
  let originalState: unknown;
  let resetFetch: () => void;
  let calls = 0;
  const now = Date.parse('2026-09-24T06:00:00Z') / 1000;
  const region = unique('maps');
  const actor: Actor = {
    kind: 'account',
    id: 'map-test',
    accountId: 'map-test',
    source: 'ui',
    role: 'dispatcher',
    tokenCategory: null,
  };
  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'Requires a disposable database');
    mock.timers.enable({ apis: ['Date'], now: now * 1000 });
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, init?: RequestInit) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        const [from, to] = body.points;
        return Response.json({
          status: 'OK',
          query: body,
          result: [
            {
              total_distance: 500,
              total_duration: 60,
              maneuvers: [
                {
                  outcoming_path: {
                    geometry: [
                      { selection: `LINESTRING(${from.lon} ${from.lat}, ${to.lon} ${to.lat})` },
                    ],
                  },
                },
              ],
            },
          ],
        });
      },
    );
    resetFetch = () => fetchMock.mock.restore();
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    db = app.get(PrismaService);
    const stored = await db.appState.findUnique({
      where: { key: APP_STATE_KEYS.DISPATCHER_SETTINGS },
    });
    originalState = stored?.value;
    await db.appState.upsert({
      where: { key: APP_STATE_KEYS.DISPATCHER_SETTINGS },
      create: {
        key: APP_STATE_KEYS.DISPATCHER_SETTINGS,
        value: { ...DEFAULT_DISPATCHER_SETTINGS, twogisApiKey: 'synthetic-test-key' },
        updatedAt: BigInt(now),
      },
      update: { value: { ...DEFAULT_DISPATCHER_SETTINGS, twogisApiKey: 'synthetic-test-key' } },
    });
    const input = { ...buildMapsDemo('2026-09-24'), region, operationId: randomUUID() };
    await app
      .get(UnitOfWork)
      .run((tx) =>
        app
          .get(UploadImportService)
          .importPackage({ tx, now, actor, operationId: input.operationId }, input, 3 * 3600),
      );
    const engineer = await db.engineer.findFirstOrThrow({ where: { region } });
    engineerId = engineer.id;
    const requests = await db.request.findMany({
      where: { region },
      orderBy: { arrivalOrder: 'asc' },
    });
    requestIds = requests.map((r) => r.id);
    const result = routerResultSchema.parse(
      buildRouterResult({
        resultId: unique('maps-result'),
        inputHash: 'a'.repeat(64),
        contextVersion: 'maps-test',
        planningAsOf: now,
        withRoadLeg: true,
        assigned: requests.map((request, index) => ({
          requestId: request.id,
          engineerId,
          lat: request.lat ?? 0,
          lon: request.lon ?? 0,
          startAt: now + 600 + index * 2400,
          durationSec: 1800,
        })),
      }),
    );
    assert.ok(result.result_id);
    assert.ok(result.input_hash);
    const recorded = await db.routerResult.create({
      data: {
        resultId: result.result_id,
        inputHash: result.input_hash,
        routerContextVersion: 'maps-test',
        status: result.status,
        payload: result as object,
        receivedAt: BigInt(now),
      },
    });
    await app
      .get(UnitOfWork)
      .run((tx) => app.get(AppliedPlanService).applyAutomatic(tx, now, result, recorded.id));
  });
  after(async () => {
    resetFetch?.();
    mock.timers.reset();
    if (db) {
      if (originalState)
        await db.appState.update({
          where: { key: APP_STATE_KEYS.DISPATCHER_SETTINGS },
          data: { value: originalState as object },
        });
      else await db.appState.deleteMany({ where: { key: APP_STATE_KEYS.DISPATCHER_SETTINGS } });
      await db.controlState.update({
        where: { id: 'singleton' },
        data: { mode: 'auto', frozenPlanId: null },
      });
      await db.appliedPlanCurrent.deleteMany({
        where: { plan: { routes: { some: { engineerId } } } },
      });
      await db.appliedPlan.deleteMany({ where: { routes: { some: { engineerId } } } });
      await db.liveRequestState.deleteMany({ where: { requestId: { in: requestIds } } });
      await db.requestFact.deleteMany({ where: { requestId: { in: requestIds } } });
      await db.request.deleteMany({ where: { region } });
      await db.engineer.deleteMany({ where: { region } });
      await db.depot.deleteMany({ where: { region } });
      await db.alert.deleteMany({
        where: {
          OR: [{ requestIds: { hasSome: requestIds } }, { engineerIds: { has: engineerId } }],
        },
      });
    }
    await app?.close();
  });
  it('uses the same timestamped forecast for dispatcher, engineer and locked LIVE reads', async () => {
    const stored = await app.get(AppliedPlanService).current(db);
    assert.ok(stored);
    const before = JSON.stringify(toPlanView(stored));
    const maps = app.get(MapRoutingService);
    const [a, b] = await Promise.all([
      maps.enrichPlan(toPlanView(stored)),
      maps.enrichPlan(toPlanView(stored)),
    ]);
    assert.deepEqual(
      a.routes.map((route) => route.stops),
      b.routes.map((route) => route.stops),
    );
    assert.deepEqual(
      a.routes.map((route) => route.mapForecast),
      b.routes.map((route) => route.mapForecast),
    );
    assert.equal(calls, 4);
    const cached = await app.get(UnitOfWork).run((tx) => maps.cachedPlan(toPlanView(stored), tx));
    assert.deepEqual(
      cached.routes.map((r) => r.stops),
      a.routes.map((r) => r.stops),
    );
    assert.equal(calls, 4);
    const live = await app.get(LiveService).engineerView(engineerId);
    assert.deepEqual(live.route?.stops, a.routes[0]?.stops);
    const after = await app.get(AppliedPlanService).current(db);
    assert.ok(after);
    assert.equal(JSON.stringify(toPlanView(after)), before);
  });
  it('forecasts a manually reordered queue without applying a new automatic plan', async () => {
    await app
      .get(UnitOfWork)
      .run((tx) =>
        transitionControl(
          { tx, now, actor, operationId: randomUUID() },
          'manual',
          'Maps acceptance',
        ),
      );
    const plan = await app.get(AppliedPlanService).current(db);
    assert.ok(plan);
    const control = await db.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    await app
      .get(UnitOfWork)
      .run((tx) =>
        app
          .get(ManualPlanService)
          .reorder(
            { tx, now, actor, operationId: randomUUID() },
            engineerId,
            [...requestIds].reverse(),
            { expectedModeVersion: control.modeVersion, expectedPlanRevision: plan.revision },
          ),
      );
    // Advance only the mocked provider wall clock beyond the minute budget.
    mock.timers.setTime((now + 61) * 1000);
    const manual = await app.get(AppliedPlanService).current(db);
    assert.ok(manual);
    const forecast = await app.get(MapRoutingService).enrichPlan(toPlanView(manual));
    assert.equal(forecast.origin, 'manual');
    assert.equal(forecast.revision, manual.revision);
    assert.deepEqual(
      forecast.routes[0]?.stops.filter((s) => s.kind === 'job').map((s) => s.requestId),
      [...requestIds].reverse(),
    );
    assert.equal(forecast.routes[0]?.timingStatus, 'forecast');
    assert.equal((await app.get(AppliedPlanService).current(db))?.revision, manual.revision);
  });
});
