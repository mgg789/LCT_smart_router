import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { uploadDataPackageSchema } from '../../src/api/dto/data.dto';
import { AppModule } from '../../src/app.module';
import type { Actor } from '../../src/auth';
import { SysError } from '../../src/common/errors';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { type OperationContext, OperationsService } from '../../src/operations';
import { AlertsService } from '../../src/orchestrator/alerts';
import { FactsService } from '../../src/orchestrator/facts';
import { DEFAULT_EXECUTION_TIMING_POLICY } from '../../src/orchestrator/facts/execution-timing-policy';
import { UploadImportService } from '../../src/orchestrator/imports';
import { LiveService } from '../../src/orchestrator/live';
import { UnitOfWork } from '../../src/persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../src/routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  ManualPlanService,
  ResultAcceptanceService,
  RouterClient,
} from '../../src/routing/router-gateway';
import {
  type PlanExpectation,
  transitionControl,
} from '../../src/routing/router-gateway/control-transition';
import { createTestClient, unique } from '../support/database';
import { buildRouterResult } from '../support/router-result';

/** Real PostgreSQL, the public 4/2 micro-set and the actual operation envelope. */
describe('DRO-70 manual control', () => {
  let app: INestApplicationContext;
  let db: PrismaClient;
  let engineers: string[];
  let requests: string[];
  let originalRevision: number;
  const operationIds: string[] = [];
  const liveDayIds: string[] = [];
  const region = unique('manual').replaceAll('-', '_');
  const now = Date.parse('2026-09-24T06:00:00Z') / 1000;
  const actor: Actor = {
    kind: 'account',
    id: 'manual-test-dispatcher',
    accountId: 'manual-test-dispatcher',
    source: 'ui',
    role: 'dispatcher',
    tokenCategory: null,
  };
  const state = async () => {
    const control = await db.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    const current = await app.get(AppliedPlanService).current(db);
    assert.ok(current);
    return { control, current };
  };
  const expectation = async (): Promise<PlanExpectation> => {
    const { control, current } = await state();
    return { expectedModeVersion: control.modeVersion, expectedPlanRevision: current.revision };
  };
  const operate = <T>(
    action: string,
    payload: unknown,
    handler: (context: OperationContext) => Promise<T>,
    operationId = randomUUID(),
  ) => {
    operationIds.push(operationId);
    return app.get(OperationsService).execute({ actor, action, operationId, payload }, handler);
  };
  const candidate = async (remaining = requests) => {
    const publication = await db.routingCurrent.findUniqueOrThrow({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    return buildRouterResult({
      resultId: unique('manual-result'),
      inputPublicationId: publication.snapshotId,
      inputHash: publication.snapshot.inputHash,
      contextVersion: 'manual-test',
      planningAsOf: now,
      assigned: remaining.map((requestId, index) => ({
        requestId,
        engineerId: must(engineers[index < 3 ? 0 : 1]),
        lat: 55.78 + index / 100,
        lon: 37.67,
        startAt: now + 600 + index * 2400,
        durationSec: 1800,
      })),
      scheduledLunchFor: [must(engineers[0])],
      lunchAfterAssignedIndex: 0,
      withRoadLeg: true,
    });
  };

  before(async () => {
    assert.ok(process.env.TEST_DATABASE_URL, 'Use a disposable test database');
    mock.timers.enable({ apis: ['Date'], now: now * 1000 });
    db = createTestClient();
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    const input = uploadDataPackageSchema.parse({
      ...JSON.parse(
        readFileSync(resolve(process.cwd(), '../../data/demo/manual-control.json'), 'utf8'),
      ),
      region,
      operationId: randomUUID(),
    });
    await operate('data.upload', input, (ctx) =>
      app.get(UploadImportService).importPackage(ctx, input, 3 * 3600),
    );
    engineers = (
      await db.engineer.findMany({ where: { region }, orderBy: { inputOrder: 'asc' } })
    ).map((e) => e.id);
    requests = (
      await db.request.findMany({ where: { region }, orderBy: { arrivalOrder: 'asc' } })
    ).map((r) => r.id);
    assert.equal(engineers.length, 2);
    assert.equal(requests.length, 4);
    const accepted = await app
      .get(ResultAcceptanceService)
      .accept(await candidate(), 'manual-test');
    assert.equal(accepted.accepted, true, JSON.stringify(accepted));
    originalRevision = (await state()).current.revision;
  });

  after(async () => {
    await app?.close();
    await db.liveWorkday.deleteMany({ where: { id: { in: liveDayIds } } });
    // All identities below belong to this fixture. Never clear another contour's data.
    await db.appliedPlanCurrent.deleteMany({
      where: { plan: { routes: { some: { engineerId: { in: engineers } } } } },
    });
    await db.appliedPlan.deleteMany({
      where: { routes: { some: { engineerId: { in: engineers } } } },
    });
    await db.requestFact.deleteMany({ where: { requestId: { in: requests } } });
    await db.request.deleteMany({ where: { region } });
    await db.engineer.deleteMany({ where: { region } });
    await db.depot.deleteMany({ where: { region } });
    await db.alert.deleteMany({
      where: {
        OR: [{ requestIds: { hasSome: requests } }, { engineerIds: { hasSome: engineers } }],
      },
    });
    await db.auditLog.deleteMany({ where: { operationId: { in: operationIds } } });
    await db.operation.deleteMany({ where: { operationId: { in: operationIds } } });
    await db.controlState.update({
      where: { id: 'singleton' },
      data: { mode: 'auto', frozenPlanId: null },
    });
    await db.$disconnect();
    mock.timers.reset();
  });

  it('opens one durable day when dispatcher and engineer arrive simultaneously', async () => {
    const service = app.get(LiveService);
    const [dispatcher, first, second] = await Promise.all([
      service.dispatchView(),
      service.engineerView(must(engineers[0])),
      service.engineerView(must(engineers[1])),
    ]);
    liveDayIds.push(must(dispatcher.workday.id));
    assert.equal(first.workday.id, dispatcher.workday.id);
    assert.equal(second.workday.id, dispatcher.workday.id);
    assert.equal(dispatcher.workday.status, 'pending');
  });

  it('rejects blank reasons even at the common service boundary', async () => {
    for (const reason of [undefined, '', ' \n '])
      await assert.rejects(
        operate('control.manual', { reason: reason ?? null }, (ctx) =>
          transitionControl(ctx, 'manual', reason),
        ),
        (error: unknown) => error instanceof SysError && error.code === 'VALIDATION_FAILED',
      );
    assert.equal((await state()).control.mode, 'auto');
    assert.equal((await state()).current.revision, originalRevision);
  });

  it('records the reason, author, time and original revision atomically', async () => {
    const expected = await expectation();
    await operate('control.manual', expected, (ctx) =>
      app.get(ControlStateService).enterManual(ctx, '  Dispatcher review  ', expected),
    );
    const entry = await db.auditLog.findFirstOrThrow({
      where: { action: 'control.transition', actorId: actor.id },
    });
    assert.equal(entry.at, BigInt(now));
    assert.deepEqual(entry.details, {
      from: 'auto',
      to: 'manual',
      reason: 'Dispatcher review',
      sourcePlanRevision: originalRevision,
      modeVersion: expected.expectedModeVersion + 1,
    });
  });

  it('reorders the full editable queue and preserves the lunch slot', async () => {
    const expected = await expectation();
    const order = [must(requests[2]), must(requests[1]), must(requests[0])];
    await operate('plan.reorder', order, (ctx) =>
      app.get(ManualPlanService).reorder(ctx, must(engineers[0]), order, expected),
    );
    const route = must((await state()).current.routes.find((r) => r.engineerId === engineers[0]));
    assert.deepEqual(
      route.stops.map((s) => s.requestId),
      [requests[2], null, requests[1], requests[0]],
    );
    assert.deepEqual(route.legs, []);
    for (const assignment of (await state()).current.assignments) {
      assert.ok(Array.isArray(assignment.reasons));
      const reason = assignment.reasons[0];
      assert.ok(reason && typeof reason === 'object' && !Array.isArray(reason));
      assert.equal(reason.code, 'MANUAL_PLAN');
    }
    assert.equal(route.assignedCount, 3);
    for (const wrong of [
      [must(requests[0])],
      [must(requests[0]), must(requests[0]), must(requests[1])],
    ]) {
      const next = await expectation();
      await assert.rejects(
        operate('plan.reorder', wrong, (ctx) =>
          app.get(ManualPlanService).reorder(ctx, must(engineers[0]), wrong, next),
        ),
        (error: unknown) => error instanceof SysError && error.code === 'VALIDATION_FAILED',
      );
    }
  });

  it('keeps inferred completed work in place while reordering the remaining queue', async () => {
    const protectedId = must(requests[2]);
    const route = must((await state()).current.routes.find((r) => r.engineerId === engineers[0]));
    const protectedSlot = must(route.stops.find((s) => s.requestId === protectedId)).sequence;
    const row = await db.liveRequestState.create({
      data: {
        workdayId: must(liveDayIds[0]),
        requestId: protectedId,
        reservedEngineerId: must(engineers[0]),
        assumedStartedAt: BigInt(now - 1800),
        assumedCompletedAt: BigInt(now),
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    try {
      const order = route.stops
        .flatMap((s) => (s.requestId && s.requestId !== protectedId ? [s.requestId] : []))
        .reverse();
      const expected = await expectation();
      await operate('plan.reorder', order, (ctx) =>
        app.get(ManualPlanService).reorder(ctx, must(engineers[0]), order, expected),
      );
      const after = must((await state()).current.routes.find((r) => r.engineerId === engineers[0]));
      assert.equal(after.stops.find((s) => s.requestId === protectedId)?.sequence, protectedSlot);
      assert.equal(
        (await db.liveRequestState.findUniqueOrThrow({ where: { id: row.id } })).assumedCompletedAt,
        BigInt(now),
      );
    } finally {
      await db.liveRequestState.delete({ where: { id: row.id } });
    }
  });

  it('does not block dashboard reads on a stalled Router evaluation', async () => {
    let release: (value: string | null) => void = () => undefined;
    const pending = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const router = app.get(RouterClient);
    const stalled = mock.method(router, 'getActiveContextVersion', () => pending);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([
          app.get(AlertsService).list(),
          app.get(AlertsService).shiftStatus('2026-09-24'),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Router blocked a business read')), 3000);
        }),
      ]);
      assert.equal(stalled.mock.callCount(), 1, 'readers share one background evaluation');
    } finally {
      clearTimeout(timer);
      release(null);
      stalled.mock.restore();
      await app.get(AlertsService).refreshAll();
    }
  });

  it('replays simultaneous duplicates without a second revision or audit change', async () => {
    const expected = await expectation();
    const id = randomUUID();
    const move = () =>
      operate(
        'plan.reassign',
        expected,
        (ctx) =>
          app.get(ManualPlanService).reassign(ctx, must(requests[0]), must(engineers[1]), expected),
        id,
      );
    const [a, b] = await Promise.all([move(), move()]);
    assert.deepEqual(a.result, b.result);
    assert.equal(await db.auditLog.count({ where: { operationId: id, action: 'plan.manual' } }), 1);
    const { current } = await state();
    assert.equal(
      current.routes.flatMap((r) => r.stops).filter((s) => s.requestId === requests[0]).length,
      1,
    );
    assert.equal(
      current.assignments.find((a) => a.requestId === requests[0])?.engineerId,
      engineers[1],
    );
    assert.equal(
      (await db.request.findUniqueOrThrow({ where: { id: requests[0] } })).assignmentState,
      'assigned',
    );
  });

  it('admits exactly one of two conflicting edits from the same revision', async () => {
    const expected = await expectation();
    const outcomes = await Promise.allSettled(
      [must(requests[1]), must(requests[2])].map((id) =>
        operate('plan.reassign', { id, expected }, (ctx) =>
          app.get(ManualPlanService).reassign(ctx, id, must(engineers[1]), expected),
        ),
      ),
    );
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = outcomes.find((r) => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof SysError);
    assert.equal(rejected.reason.code, 'VERSION_CONFLICT');
  });

  it('reports skill, transport, window and shift conflicts without using Router', async () => {
    await db.engineer.update({
      where: { id: engineers[1] },
      data: { skills: ['local'], transportType: 'walk' },
    });
    await db.engineerDay.updateMany({
      where: { engineerId: engineers[1] },
      data: { shiftEndAt: BigInt(now + 60) },
    });
    await db.request.update({ where: { id: requests[3] }, data: { windowEndAt: BigInt(now - 1) } });
    const expected = await expectation();
    const preview = await app
      .get(UnitOfWork)
      .run((tx) =>
        app
          .get(ManualPlanService)
          .preview(
            { tx, now, actor, operationId: randomUUID() },
            { kind: 'reassign', requestId: must(requests[3]), engineerId: must(engineers[1]) },
            expected,
          ),
      );
    for (const code of [
      'SKILL_MISMATCH',
      'TRANSPORT_MISMATCH',
      'WINDOW_CONFLICT',
      'SHIFT_CONFLICT',
    ])
      assert.ok(
        preview.warnings.some((w) => w.code === code),
        code,
      );
    assert.equal(
      (await state()).current.revision,
      expected.expectedPlanRevision,
      'preview is read-only',
    );
    await db.engineer.update({
      where: { id: engineers[1] },
      data: { skills: ['connection', 'emergency', 'local'], transportType: 'car' },
    });
    await db.engineerDay.updateMany({
      where: { engineerId: engineers[1] },
      data: { shiftEndAt: BigInt(now + 9 * 3600) },
    });
    await db.request.update({
      where: { id: requests[3] },
      data: { windowEndAt: BigInt(now + 7 * 3600) },
    });
  });

  it('protects started and completed work and retains execution facts', async () => {
    const facts = app.get(FactsService);
    await operate('fact.started', {}, (ctx) =>
      facts.record(
        ctx,
        must(engineers[1]),
        must(requests[0]),
        'started',
        now,
        null,
        DEFAULT_EXECUTION_TIMING_POLICY,
      ),
    );
    const expected = await expectation();
    await assert.rejects(
      operate('plan.reassign', expected, (ctx) =>
        app.get(ManualPlanService).reassign(ctx, must(requests[0]), must(engineers[0]), expected),
      ),
      (error: unknown) => error instanceof SysError && error.code === 'WORK_ALREADY_STARTED',
    );
    const oldRoute = must(
      (await state()).current.routes.find((r) => r.engineerId === engineers[1]),
    );
    const protectedSequence = must(
      oldRoute.stops.find((s) => s.requestId === requests[0]),
    ).sequence;
    const order = oldRoute.stops
      .flatMap((s) => (s.requestId && s.requestId !== requests[0] ? [s.requestId] : []))
      .reverse();
    await operate('plan.reorder', order, (ctx) =>
      app.get(ManualPlanService).reorder(ctx, must(engineers[1]), order, expected),
    );
    const newRoute = must(
      (await state()).current.routes.find((r) => r.engineerId === engineers[1]),
    );
    assert.equal(
      must(newRoute.stops.find((s) => s.requestId === requests[0])).sequence,
      protectedSequence,
    );
    await operate('fact.finished', {}, (ctx) =>
      facts.record(
        ctx,
        must(engineers[1]),
        must(requests[0]),
        'finished',
        now + 1800,
        null,
        DEFAULT_EXECUTION_TIMING_POLICY,
      ),
    );
    const after = await expectation();
    await assert.rejects(
      operate('plan.reassign', after, (ctx) =>
        app.get(ManualPlanService).reassign(ctx, must(requests[0]), must(engineers[0]), after),
      ),
      (error: unknown) => error instanceof SysError && error.code === 'WORK_ALREADY_STARTED',
    );
    assert.equal(await db.requestFact.count({ where: { requestId: requests[0] } }), 2);
  });

  it('serializes an engineer start against a simultaneous reassignment', async () => {
    const requestId = must(requests[3]);
    const current = (await state()).current;
    const owner = must(
      current.assignments.find((assignment) => assignment.requestId === requestId)?.engineerId,
    );
    const target = must(engineers.find((id) => id !== owner));
    const expected = await expectation();
    const outcomes = await Promise.allSettled([
      operate('fact.started', { requestId }, (ctx) =>
        app
          .get(FactsService)
          .record(ctx, owner, requestId, 'started', now, null, DEFAULT_EXECUTION_TIMING_POLICY),
      ),
      operate('plan.reassign', { requestId, target, expected }, (ctx) =>
        app.get(ManualPlanService).reassign(ctx, requestId, target, expected),
      ),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const started = await db.requestFact.findFirst({ where: { requestId, kind: 'started' } });
    const assigned = (await state()).current.assignments.find(
      (assignment) => assignment.requestId === requestId,
    )?.engineerId;
    if (started) {
      assert.equal(assigned, started.engineerId);
      await operate('fact.finished', { requestId }, (ctx) =>
        app
          .get(FactsService)
          .record(
            ctx,
            owner,
            requestId,
            'finished',
            now + 1800,
            null,
            DEFAULT_EXECUTION_TIMING_POLICY,
          ),
      );
    } else assert.equal(assigned, target);
  });

  it('ignores a late Router result and restores the exact plan after app restart', async () => {
    const before = await state();
    const outcome = await app.get(ResultAcceptanceService).accept(await candidate(), 'manual-test');
    assert.equal(outcome.reason, 'MODE_MANUAL');
    await app.close();
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    assert.deepEqual(await state(), before);
  });

  it('keeps the manual plan visible until a suitable AUTO result and preserves facts', async () => {
    const expected = await expectation();
    await operate('control.auto', expected, (ctx) =>
      app.get(ControlStateService).returnToAuto(ctx, expected),
    );
    assert.equal((await state()).current.revision, expected.expectedPlanRevision);
    const invalid = await app.get(ResultAcceptanceService).accept(await candidate(), 'manual-test');
    assert.equal(invalid.accepted, false, 'completed work cannot be redistributed');
    await app
      .get(UnitOfWork)
      .run((tx) =>
        app
          .get(SnapshotPublisher)
          .publishIfChanged(tx, now + 1800, PUBLICATION_TRIGGERS.REQUEST_EXECUTION_VARIANCE),
      );
    const accepted = await app
      .get(ResultAcceptanceService)
      .accept(
        await candidate(
          (
            await db.request.findMany({ where: { id: { in: requests }, lifecycle: 'submitted' } })
          ).map((request) => request.id),
        ),
        'manual-test',
      );
    assert.equal(accepted.accepted, true, JSON.stringify(accepted));
    assert.equal((await state()).current.origin, 'auto');
    assert.equal(await db.requestFact.count({ where: { requestId: requests[0] } }), 2);
    assert.equal(
      (await db.request.findUniqueOrThrow({ where: { id: requests[0] } })).lifecycle,
      'completed',
    );
  });

  it('can create the first manual working plan without any accepted Router result', async () => {
    // Model a fresh contour with submitted input and no current applied plan.
    await db.appliedPlanCurrent.deleteMany({});
    const previous = await db.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    const entry = { expectedModeVersion: previous.modeVersion, expectedPlanRevision: 0 };
    await operate('control.manual', entry, (ctx) =>
      app
        .get(ControlStateService)
        .enterManual(ctx, 'Router unavailable before first calculation', entry),
    );
    const control = await db.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    const request = await db.request.findFirstOrThrow({
      where: { id: { in: requests }, lifecycle: 'submitted' },
    });
    const expected = { expectedModeVersion: control.modeVersion, expectedPlanRevision: 0 };
    await operate('plan.reassign', { requestId: request.id, expected }, (ctx) =>
      app.get(ManualPlanService).reassign(ctx, request.id, must(engineers[0]), expected),
    );
    const { current } = await state();
    assert.equal(current.origin, 'manual');
    assert.equal(current.routerResultId, null);
    assert.deepEqual(
      current.assignments.map((assignment) => assignment.requestId),
      [request.id],
    );
    assert.equal(current.routes[0]?.assignedCount, 1);
  });
});

function must<T>(value: T | null | undefined): T {
  assert.ok(value !== undefined && value !== null, 'Required micro-set fixture value');
  return value;
}
