import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import type { Actor } from '../../src/auth';
import { SysError } from '../../src/common/errors';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { OperationsService } from '../../src/operations';
import { AlertsService } from '../../src/orchestrator/alerts';
import { EngineersService } from '../../src/orchestrator/engineers';
import { UnitOfWork } from '../../src/persistence';
import { RouterClient } from '../../src/routing/router-gateway/router-client.port';
import { createTestClient, databaseUrl, unique } from '../support/database';

/** Exercises the durable queue against PostgreSQL: seen is not a resolution and a
 * distinct retry cannot apply the same decision twice after the alert-queue lock. */
describe('dispatcher alert lifecycle', () => {
  let app: INestApplicationContext;
  let prisma: PrismaClient;
  let operations: OperationsService;
  let alerts: AlertsService;
  const ids: string[] = [];
  const opIds: string[] = [];
  const requestIds: string[] = [];
  const engineerIds: string[] = [];
  const accountIds: string[] = [];
  const liveDayIds: string[] = [];
  const actor: Actor = {
    kind: 'account',
    source: 'ui',
    id: 'alert-test-dispatcher',
    role: 'dispatcher',
    tokenCategory: null,
    accountId: 'alert-test-dispatcher',
  };
  const date = '2099-12-31';

  before(async () => {
    const morning = new Date();
    morning.setUTCHours(9, 0, 0, 0);
    mock.timers.enable({ apis: ['Date'], now: morning });
    assert.ok(
      process.env.TEST_DATABASE_URL,
      'Use an isolated TEST_DATABASE_URL for alert integration tests',
    );
    process.env.NODE_ENV = 'test';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
      abortOnError: false,
    });
    operations = app.get(OperationsService);
    alerts = app.get(AlertsService);
  });
  after(async () => {
    await prisma.liveWorkday.deleteMany({ where: { id: { in: liveDayIds } } });
    await prisma.shiftClosure.deleteMany({ where: { workDate: date } });
    await prisma.alert.deleteMany({ where: { id: { in: ids } } });
    await prisma.alert.deleteMany({
      where: {
        OR: [{ engineerIds: { hasSome: engineerIds } }, { requestIds: { hasSome: requestIds } }],
      },
    });
    await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.engineer.deleteMany({ where: { id: { in: engineerIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.auditLog.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.operation.deleteMany({ where: { operationId: { in: opIds } } });
    await prisma.$disconnect();
    mock.timers.reset();
    await app?.close();
  });

  it('a vanished Router condition creates a new episode when it returns', async () => {
    const routerId = unique('router-condition');
    const firstResult = unique('router-result');
    const nextResult = unique('router-result');
    const now = Math.floor(Date.now() / 1000);
    const input = {
      id: routerId,
      code: 'lunch_conflict',
      severity: 'warning' as const,
      engineerIds: [],
      requestIds: [],
      reasons: {},
      restoreOption: null,
      sourceResultId: firstResult,
      workDate: date,
    };
    await app.get(UnitOfWork).run((tx) => alerts.ingestRouter(tx, now, input));
    const first = await prisma.alert.findFirstOrThrow({ where: { sourceResultId: firstResult } });
    ids.push(first.id);
    await prisma.alert.update({
      where: { id: first.id },
      data: { resolvedAt: BigInt(now), resolutionAction: 'keep_lunch' },
    });
    await app
      .get(UnitOfWork)
      .run((tx) => alerts.invalidateOtherRouterConditions(tx, now + 1, nextResult));
    await app
      .get(UnitOfWork)
      .run((tx) => alerts.ingestRouter(tx, now + 2, { ...input, sourceResultId: nextResult }));
    const second = await prisma.alert.findFirstOrThrow({
      where: { sourceResultId: nextResult, resolvedAt: null },
    });
    ids.push(second.id);
    assert.notEqual(second.id, first.id);
    await app
      .get(UnitOfWork)
      .run((tx) => alerts.ingestRouter(tx, now + 3, { ...input, sourceResultId: nextResult }));
    assert.equal(await prisma.alert.count({ where: { sourceResultId: nextResult } }), 1);
    await prisma.alert.update({
      where: { id: second.id },
      data: { resolvedAt: BigInt(now + 4), resolutionAction: 'keep_lunch' },
    });
  });

  it('seen alert still blocks the shift; resolve is durable and idempotent', async () => {
    const id = randomUUID();
    ids.push(id);
    await prisma.alert.create({
      data: {
        id,
        dedupKey: unique('alert'),
        code: 'plan_degraded',
        severity: 'warning',
        engineerIds: [],
        requestIds: [],
        reasons: {},
        workDate: date,
        isBlocking: true,
        createdAt: BigInt(Math.floor(Date.now() / 1000) - 181),
      },
    });
    await alerts.markSeen(id, Math.floor(Date.now() / 1000));
    const closeId = randomUUID();
    opIds.push(closeId);
    await assert.rejects(
      () =>
        operations.execute(
          {
            operationId: closeId,
            actor,
            action: 'shift.close',
            targetRef: date,
            payload: { workDate: date },
          },
          (context) => alerts.closeShift(context, date),
        ),
      (error: unknown) => error instanceof SysError && error.code === 'SHIFT_CLOSE_BLOCKED',
    );
    const resolveId = randomUUID();
    opIds.push(resolveId);
    const request = {
      operationId: resolveId,
      actor,
      action: 'alert.resolve',
      targetRef: id,
      payload: { action: 'keep_manual', reason: 'dispatcher reviewed' },
    };
    const first = await operations.execute(request, (context) =>
      alerts.resolve(context, id, { action: 'keep_manual', reason: 'dispatcher reviewed' }),
    );
    const repeat = await operations.execute(request, () => {
      throw new Error('handler must not run');
    });
    assert.equal(first.replayed, false);
    assert.equal(repeat.replayed, true);
    const row = await prisma.alert.findUniqueOrThrow({ where: { id } });
    assert.equal(row.seenAt === null, false);
    assert.equal(row.resolutionAction, 'keep_manual');
    assert.equal(row.resolutionDelaySec === null, false);
  });

  it('defers free LIVE work once without publishing a replacement plan, even with concurrent retries', async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = await prisma.liveWorkday.create({
      data: {
        generation: 998,
        workDate: new Date((now + 10800) * 1000).toISOString().slice(0, 10),
        status: 'running',
        logicalStartAt: BigInt(now),
        logicalEndAt: BigInt(now + 3600),
        startedAtWallSec: BigInt(now),
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    liveDayIds.push(day.id);
    const publicationsBefore = await prisma.routingSnapshot.count();
    const request = await prisma.request.create({
      data: {
        arrivalOrder: 991,
        addressText: 'Integration alert request',
        lat: 55.75,
        lon: 37.6,
        needsGeocoding: false,
        normProfileCode: 'local',
        normativeTravelDurationSec: 600,
        technicalDurationSec: 600,
        documentationDurationSec: 300,
        serviceDurationSec: 900,
        windowStartAt: BigInt(now + 300),
        windowEndAt: BigInt(now + 3600),
        requiredSkill: 'local',
        lifecycle: 'submitted',
        assignmentState: 'unassigned',
        origin: 'manual',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    requestIds.push(request.id);
    const issue = await prisma.alert.create({
      data: {
        code: 'unassigned',
        severity: 'error',
        engineerIds: [],
        requestIds: [request.id],
        reasons: [],
        createdAt: BigInt(now),
        workDate: date,
      },
    });
    ids.push(issue.id);
    const invoke = () => {
      const operationId = randomUUID();
      opIds.push(operationId);
      return operations.execute(
        {
          operationId,
          actor,
          action: 'alert.resolve',
          targetRef: issue.id,
          payload: { action: 'reschedule' },
        },
        (context) => alerts.resolve(context, issue.id, { action: 'reschedule' }),
      );
    };
    await Promise.all([invoke(), invoke()]);
    const changed = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(changed.windowStartAt, request.windowStartAt + 86400n);
    assert.equal(await prisma.routingSnapshot.count(), publicationsBefore);
    assert.equal(
      await prisma.requestConditionHistory.count({ where: { requestId: request.id } }),
      1,
    );
    await prisma.request.update({ where: { id: request.id }, data: { lifecycle: 'cancelled' } });
    await alerts.refreshAll();
    await prisma.liveWorkday.delete({ where: { id: day.id } });
  });

  it('keeps one unassigned episode across polling and closes both sources after assignment', async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const request = await prisma.request.create({
      data: {
        arrivalOrder: 993,
        addressText: 'Stable alert regression',
        lat: 55.75,
        lon: 37.6,
        needsGeocoding: false,
        normProfileCode: 'local',
        normativeTravelDurationSec: 600,
        technicalDurationSec: 600,
        documentationDurationSec: 300,
        serviceDurationSec: 900,
        windowStartAt: now,
        windowEndAt: now + 3600n,
        requiredSkill: 'local',
        lifecycle: 'submitted',
        assignmentState: 'unassigned',
        origin: 'manual',
        createdAt: now,
        updatedAt: now,
      },
    });
    requestIds.push(request.id);
    await alerts.refreshAll();
    const first = await prisma.alert.findFirstOrThrow({
      where: {
        requestIds: { has: request.id },
        code: 'unassigned',
        resolvedAt: null,
      },
    });
    await alerts.refreshAll();
    await alerts.refreshAll();
    const open = await prisma.alert.findMany({
      where: {
        requestIds: { has: request.id },
        code: 'unassigned',
        resolvedAt: null,
      },
    });
    assert.deepEqual(
      open.map((item) => item.id),
      [first.id],
    );
    const operationId = randomUUID();
    opIds.push(operationId);
    const beforePreview = await prisma.routingSnapshot.count();
    const transport = mock.method(app.get(RouterClient), 'proposeWindow', async (preview) => {
      assert.ok(preview.snapshot.requests.some((item) => item.request_id === request.id));
      assert.equal(preview.request_id, request.id);
      return { status: 'none' as const, proposal: null };
    });
    try {
      const preview = await alerts.proposeWindow(first.id);
      assert.equal(preview.status, 'none');
      assert.equal(preview.requestVersion, request.version);
      assert.equal(await prisma.routingSnapshot.count(), beforePreview, 'preview must not publish');
    } finally {
      transport.mock.restore();
    }
    const input = {
      action: 'move_window' as const,
      expectedRequestVersion: request.version,
      windowStartAt: Number(now) + 600,
      windowEndAt: Number(now) + 1200,
    };
    await operations.execute(
      { operationId, actor, action: 'alert.resolve', targetRef: first.id, payload: input },
      (context) => alerts.resolve(context, first.id, input),
    );
    const staleId = randomUUID();
    opIds.push(staleId);
    await assert.rejects(
      () =>
        operations.execute(
          {
            operationId: staleId,
            actor,
            action: 'alert.resolve',
            targetRef: first.id,
            payload: input,
          },
          (context) => alerts.resolve(context, first.id, input),
        ),
      (error: unknown) => error instanceof SysError && error.code === 'VERSION_CONFLICT',
    );
    await alerts.refreshAll();
    assert.equal(
      (await prisma.alert.findUniqueOrThrow({ where: { id: first.id } })).resolvedAt,
      null,
      'changing the window is not a successful assignment',
    );
    assert.equal(
      (await prisma.request.findUniqueOrThrow({ where: { id: request.id } })).assignmentState,
      'pending',
    );
    await prisma.request.update({
      where: { id: request.id },
      data: { assignmentState: 'unassigned' },
    });
    await alerts.refreshAll();
    assert.equal(
      (await prisma.alert.findUniqueOrThrow({ where: { id: first.id } })).resolvedAt,
      null,
      'an infeasible Router result keeps the same alert open',
    );
    // A Router episode for the exact same request is reused without adding
    // another system card on every refresh.
    await prisma.alert.update({
      where: { id: first.id },
      data: {
        dedupKey: `router:unassigned:${request.id}`,
      },
    });
    await alerts.refreshAll();
    assert.equal(
      await prisma.alert.count({
        where: {
          requestIds: { has: request.id },
          resolvedAt: null,
        },
      }),
      1,
    );
    await prisma.alert.create({
      data: {
        dedupKey: `system:unassigned:legacy:${request.id}`,
        code: 'unassigned',
        severity: 'error',
        requestIds: [request.id],
        engineerIds: [],
        reasons: {},
        createdAt: now,
      },
    });
    await prisma.request.update({
      where: { id: request.id },
      data: { assignmentState: 'assigned' },
    });
    await alerts.refreshAll();
    assert.equal(
      await prisma.alert.count({
        where: {
          requestIds: { has: request.id },
          code: 'unassigned',
          resolvedAt: null,
        },
      }),
      0,
    );
    assert.equal(await prisma.alert.count({ where: { requestIds: { has: request.id } } }), 2);
  });

  it('tracks no-show without email once and honours opt-out and an explicit extension', async () => {
    const now = Math.floor(Date.now() / 1000);
    const workDate = new Date((now + 10800) * 1000).toISOString().slice(0, 10);
    const engineer = await prisma.engineer.create({
      data: {
        displayName: 'Alert test crew',
        inputOrder: 991,
        skills: ['local'],
        transportType: 'car',
        origin: 'manual',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    engineerIds.push(engineer.id);
    await prisma.engineerDay.create({
      data: {
        engineerId: engineer.id,
        workDate,
        shiftStartAt: BigInt(now - 3600),
        shiftEndAt: BigInt(now + 3600),
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    await alerts.refreshAll();
    assert.equal(
      await prisma.alert.count({ where: { engineerIds: { has: engineer.id }, resolvedAt: null } }),
      1,
    );
    const account = await prisma.account.create({
      data: {
        email: `${unique('alerts')}@example.test`,
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    accountIds.push(account.id);
    await prisma.engineer.update({ where: { id: engineer.id }, data: { accountId: account.id } });
    await alerts.refreshAll();
    const first = await prisma.alert.findFirstOrThrow({
      where: { engineerIds: { has: engineer.id }, code: 'shift_no_show', resolvedAt: null },
    });
    await alerts.refreshAll();
    assert.equal(
      await prisma.alert.count({ where: { engineerIds: { has: engineer.id }, resolvedAt: null } }),
      1,
    );
    assert.equal(
      await prisma.alert.count({
        where: { engineerIds: { has: engineer.id }, code: 'shift_no_show' },
      }),
      1,
    );
    const operationId = randomUUID();
    opIds.push(operationId);
    await operations.execute(
      {
        operationId,
        actor,
        action: 'alert.resolve',
        targetRef: first.id,
        payload: { action: 'extend', minutes: 15 },
      },
      (context) => alerts.resolve(context, first.id, { action: 'extend', minutes: 15 }),
    );
    await alerts.refreshAll();
    assert.equal(
      await prisma.alert.count({ where: { engineerIds: { has: engineer.id }, resolvedAt: null } }),
      0,
    );
    const day = await prisma.engineerDay.findUniqueOrThrow({
      where: { engineerId_workDate: { engineerId: engineer.id, workDate } },
    });
    assert.ok(day.attendanceGraceUntil !== null && day.attendanceGraceUntil >= BigInt(now + 900));
    await prisma.engineerDay.update({
      where: { id: day.id },
      data: { attendanceGraceUntil: BigInt(now - 1) },
    });
    await alerts.refreshAll();
    assert.equal(
      await prisma.alert.count({ where: { engineerIds: { has: engineer.id }, resolvedAt: null } }),
      1,
    );
    await prisma.engineerDay.update({ where: { id: day.id }, data: { attendanceOptOut: true } });
    await alerts.refreshAll();
    assert.equal(
      await prisma.alert.count({ where: { engineerIds: { has: engineer.id }, resolvedAt: null } }),
      0,
    );
    await assert.rejects(() =>
      app
        .get(UnitOfWork)
        .run((tx) =>
          app
            .get(EngineersService)
            .recordAttendance(
              { tx, actor, now: Number(day.shiftStartAt) - 1, operationId: randomUUID() },
              engineer.id,
            ),
        ),
    );
  });

  it('removes stale direct LIVE window alerts and ignores archived engineer days', async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleAlert = await prisma.alert.create({
      data: {
        code: 'LIVE_WINDOW_COMPLETION_RISK',
        severity: 'warning',
        engineerIds: [],
        requestIds: [unique('finished-request')],
        reasons: [{ code: 'LIVE_WINDOW_COMPLETION_RISK', facts: { completionGraceSec: 600 } }],
        createdAt: BigInt(now - 60),
      },
    });
    ids.push(staleAlert.id);
    const archivedEngineer = await prisma.engineer.create({
      data: {
        displayName: 'Archived alert test crew',
        inputOrder: 992,
        skills: ['local'],
        transportType: 'car',
        origin: 'manual',
        archivedAt: BigInt(now),
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    engineerIds.push(archivedEngineer.id);
    await prisma.engineerDay.create({
      data: {
        engineerId: archivedEngineer.id,
        workDate: new Date((now + 10800) * 1000).toISOString().slice(0, 10),
        shiftStartAt: BigInt(now - 3600),
        shiftEndAt: BigInt(now + 3600),
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
      },
    });
    await alerts.refreshAll();
    const refreshed = await prisma.alert.findUniqueOrThrow({ where: { id: staleAlert.id } });
    assert.equal(refreshed.invalidatedAt === null, false);
    assert.equal(
      await prisma.alert.count({
        where: {
          engineerIds: { has: archivedEngineer.id },
          code: 'shift_no_show',
          resolvedAt: null,
        },
      }),
      0,
    );
  });
});
