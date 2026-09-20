import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
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

  it('moves the actual request window once even with concurrent distinct operation ids', async () => {
    const now = Math.floor(Date.now() / 1000);
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
    assert.equal(
      await prisma.requestConditionHistory.count({ where: { requestId: request.id } }),
      1,
    );
    await prisma.request.update({ where: { id: request.id }, data: { lifecycle: 'cancelled' } });
    await alerts.refreshAll();
  });

  it('exempts missing email and opt-out days and honours an explicit no-show extension', async () => {
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
      0,
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
});
