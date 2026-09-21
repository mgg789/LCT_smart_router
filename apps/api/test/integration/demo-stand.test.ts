import '../support/demo-stand.env';
import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl, unique } from '../support/database';

const moscowDate = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

describe('public demo stand rewind', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const signInDispatcher = async (): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/v1/auth/dispatcher/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return ((await response.json()) as { token: string }).token;
  };

  before(async () => {
    process.env.DEMO_STAND = 'true';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    await prisma.liveWorkday.deleteMany({});
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'health/services'],
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    dispatcherToken = await signInDispatcher();
  });

  after(async () => {
    delete process.env.DEMO_STAND;
    if (prisma) {
      await prisma.appliedPlanCurrent.deleteMany({});
      await prisma.appliedPlanStop.deleteMany({});
      await prisma.appliedPlanRoute.deleteMany({});
      await prisma.appliedPlanAssignment.deleteMany({});
      await prisma.appliedPlan.deleteMany({});
      await prisma.routerResult.deleteMany({});
      await prisma.alert.deleteMany({});
      await prisma.shiftClosure.deleteMany({});
      await prisma.routingCurrent.deleteMany({});
      await prisma.routingSnapshot.deleteMany({});
      await prisma.liveWorkday.deleteMany({});
      await prisma.requestFact.deleteMany({});
      await prisma.requestConditionHistory.deleteMany({});
      await prisma.request.deleteMany({});
      await prisma.engineerDay.deleteMany({});
      await prisma.engineer.deleteMany({});
      await prisma.depot.deleteMany({});
      await prisma.notificationIntent.deleteMany({});
      await prisma.externalIdMap.deleteMany({});
      await prisma.importPackage.deleteMany({});
      await prisma.accountRole.deleteMany({ where: { role: { in: ['client', 'engineer'] } } });
      await prisma.account.deleteMany({ where: { roles: { none: {} } } });
    }
    await app?.close();
    await prisma?.$disconnect();
  });

  it('seeds fourteen requests and two engineers for the current Moscow date', async () => {
    const live = await call('GET', '/api/v1/dispatch/live', dispatcherToken);
    assert.equal(live.status, 200, await live.clone().text());
    const body = (await live.json()) as {
      demoStand: boolean;
      workday: { workDate: string; status: string };
    };
    assert.equal(body.demoStand, true);
    assert.equal(body.workday.workDate, moscowDate());
    assert.equal(body.workday.status, 'pending');
    assert.equal(await prisma.request.count(), 14);
    assert.equal(await prisma.engineer.count({ where: { archivedAt: null } }), 2);
  });

  it('rewinds linked mail and extra requests without signing the dispatcher out', async () => {
    const engineers = await call('GET', '/api/v1/dispatch/engineers', dispatcherToken);
    assert.equal(engineers.status, 200, await engineers.clone().text());
    const first = (
      (await engineers.json()) as { engineers: Array<{ id: string; hasAccount: boolean }> }
    ).engineers[0];
    assert.ok(first);
    const email = `${unique('demo-eng')}@example.test`;
    const linked = await call('POST', '/api/v1/dispatch/engineers/link-account', dispatcherToken, {
      operationId: randomUUID(),
      engineerId: first.id,
      email,
    });
    assert.equal(linked.status, 201, await linked.clone().text());

    const extra = await call('POST', '/api/v1/dispatch/requests', dispatcherToken, {
      operationId: randomUUID(),
      contactName: 'Demo extra',
      addressText: 'Москва, тестовая 1',
      lat: 55.75,
      lon: 37.62,
      workType: 'monitoring',
      windowStartAt: Math.floor(Date.now() / 1000) + 3600,
      windowEndAt: Math.floor(Date.now() / 1000) + 7200,
    });
    assert.equal(extra.status, 201, await extra.clone().text());
    assert.ok((await prisma.request.count()) > 14);

    const restarted = await call('POST', '/api/v1/dispatch/data/restart-demo', dispatcherToken, {
      operationId: randomUUID(),
    });
    assert.equal(restarted.status, 201, await restarted.clone().text());
    const summary = (await restarted.json()) as {
      restored: boolean;
      workDate: string;
      requestsCreated: number;
      engineersCreated: number;
    };
    assert.equal(summary.restored, true);
    assert.equal(summary.workDate, moscowDate());
    assert.equal(summary.requestsCreated, 14);
    assert.equal(summary.engineersCreated, 2);

    const stillIn = await call('GET', '/api/v1/dispatch/live', dispatcherToken);
    assert.equal(stillIn.status, 200, await stillIn.clone().text());
    assert.equal(await prisma.request.count(), 14);
    const roster = await call('GET', '/api/v1/dispatch/engineers', dispatcherToken);
    const listed = (
      (await roster.json()) as {
        engineers: Array<{ email: string | null; hasAccount: boolean }>;
      }
    ).engineers;
    assert.equal(listed.length, 2);
    assert.ok(listed.every((item) => item.hasAccount === false && item.email === null));
    assert.equal(await prisma.account.count({ where: { email } }), 0);
  });
});
