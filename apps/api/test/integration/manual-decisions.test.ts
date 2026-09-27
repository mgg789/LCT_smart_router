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

const HOUR = 3600;

describe('manual decision endpoints', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;
  let clientToken: string;
  const emails: string[] = [];
  const requestIds: string[] = [];
  const call = async (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const signIn = async (email: string, role: 'client' | 'engineer'): Promise<string> => {
    const codeResponse = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const { devCode } = (await codeResponse.json()) as { devCode: string };
    const verify = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role }),
    });
    assert.equal(verify.status, 201, await verify.clone().text());
    return ((await verify.json()) as { token: string }).token;
  };

  const now = (): number => Math.floor(Date.now() / 1000);
  /** Creates and confirms a request, which also republishes the task. */
  const submitRequest = async (
    workType = 'connection_request',
    requiredEquipment?: 'router' | 'set_top_box' | 'smart_speaker',
  ): Promise<{ id: string; lat: number; lon: number }> => {
    const prepared = await call('POST', '/api/v1/client/requests', clientToken, {
      operationId: randomUUID(),
      contactName: 'Gateway Customer',
      addressText: 'Москва, ул. Тестовая, д. 7',
      lat: 55.78,
      lon: 37.66,
      workType,
      requiredEquipment,
      windowStartAt: now() + HOUR,
      windowEndAt: now() + 3 * HOUR,
    });
    const request = ((await prepared.json()) as { request: { id: string; version: number } })
      .request;
    requestIds.push(request.id);
    await call('POST', `/api/v1/client/requests/${request.id}/submit`, clientToken, {
      operationId: randomUUID(),
      expectedVersion: request.version,
    });
    return { id: request.id, lat: 55.78, lon: 37.66 };
  };

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DEV_EXPOSE_CODES = 'true';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();

    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'health/services'],
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const dispatcher = await fetch(`${baseUrl}/api/v1/auth/dispatcher/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      }),
    });
    dispatcherToken = ((await dispatcher.json()) as { token: string }).token;

    const clientEmail = `${unique('gw-client')}@example.test`;
    emails.push(clientEmail);
    clientToken = await signIn(clientEmail, 'client');
  });
  after(async () => {
    await prisma.alert.deleteMany({ where: { requestIds: { hasSome: requestIds } } });
    await prisma.requestFact.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.requestConditionHistory.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.notificationIntent.deleteMany({ where: { recipientEmail: { in: emails } } });
    await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.account.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
    await prisma.$disconnect();
  });
  it('persists versioned manual decisions, validates consent and orders all priorities', async () => {
    const request = await submitRequest();
    const missingReason = await call('POST', '/api/v1/dispatch/mode', dispatcherToken, {
      operationId: randomUUID(),
      mode: 'manual',
    });
    assert.equal(missingReason.status, 422);
    const enter = await call('POST', '/api/v1/dispatch/mode', dispatcherToken, {
      operationId: randomUUID(),
      mode: 'manual',
      reason: 'Customer scheduling priority',
    });
    assert.equal(enter.status, 201, await enter.clone().text());
    type ManualView = {
      version: number;
      decisions: Array<{
        id: string;
        kind: string;
        priority: number;
        engineerId?: string | null;
      }>;
      reason: string | null;
    };
    const read = async () => {
      const response = await call('GET', '/api/v1/dispatch/manual', dispatcherToken);
      assert.equal(response.status, 200);
      return (await response.json()) as ManualView;
    };
    try {
      const initial = await read();
      assert.equal(initial.reason, 'Customer scheduling priority');
      const forbidden = await call('GET', '/api/v1/dispatch/manual', clientToken);
      assert.equal(forbidden.status, 403);
      const payload = {
        operationId: randomUUID(),
        expectedVersion: initial.version,
        kind: 'assignment',
        targetId: request.id,
        engineerId: null,
      };
      const saved = await call(
        'POST',
        '/api/v1/dispatch/manual/decisions',
        dispatcherToken,
        payload,
      );
      assert.equal(saved.status, 201, await saved.clone().text());
      let state = (await saved.json()) as ManualView;
      assert.equal(state.decisions[0]?.engineerId, null);
      const published = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
      const debug = (await published.json()) as { payload: string };
      const snapshot = JSON.parse(debug.payload) as {
        manual_decisions?: Array<{ target_id: string; engineer_id: string | null }>;
      };
      assert.ok(
        snapshot.manual_decisions?.some(
          (item) => item.target_id === request.id && item.engineer_id === null,
        ),
      );
      const original = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      const replay = await call(
        'POST',
        '/api/v1/dispatch/manual/decisions',
        dispatcherToken,
        payload,
      );
      assert.equal(replay.status, 201);
      assert.equal(((await replay.json()) as ManualView).version, state.version);
      const stale = await call('POST', '/api/v1/dispatch/manual/decisions', dispatcherToken, {
        ...payload,
        operationId: randomUUID(),
      });
      assert.equal(stale.status, 409);
      const window = await call('POST', '/api/v1/dispatch/manual/decisions', dispatcherToken, {
        operationId: randomUUID(),
        expectedVersion: state.version,
        kind: 'window',
        targetId: request.id,
        startAt: now() + 2 * HOUR,
        endAt: now() + 4 * HOUR,
      });
      assert.equal(window.status, 422, await window.clone().text());
      const challenge = (await window.json()) as { error: { details: { kind: string } } };
      assert.equal(challenge.error.details.kind, 'window_change_confirmation');
      assert.equal(
        (await read()).version,
        state.version,
        'unconfirmed window must not create a decision',
      );
      const unchanged = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      assert.equal(unchanged.windowStartAt, original.windowStartAt);
      assert.equal(unchanged.windowEndAt, original.windowEndAt);
      const invalidOrder = await call(
        'POST',
        '/api/v1/dispatch/manual/priorities',
        dispatcherToken,
        { operationId: randomUUID(), expectedVersion: state.version, decisionIds: [] },
      );
      assert.equal(invalidOrder.status, 422);
      const ordered = await call('POST', '/api/v1/dispatch/manual/priorities', dispatcherToken, {
        operationId: randomUUID(),
        expectedVersion: state.version,
        decisionIds: state.decisions.map((item) => item.id),
      });
      assert.equal(ordered.status, 201);
      state = (await ordered.json()) as ManualView;
      const decision = state.decisions[0];
      assert.ok(decision);
      const removed = await call(
        'DELETE',
        `/api/v1/dispatch/manual/decisions/${decision.id}`,
        dispatcherToken,
        { operationId: randomUUID(), expectedVersion: state.version },
      );
      assert.equal(removed.status, 200);
      assert.deepEqual(((await removed.json()) as ManualView).decisions, []);
    } finally {
      await call('POST', '/api/v1/dispatch/mode', dispatcherToken, {
        operationId: randomUUID(),
        mode: 'auto',
      });
    }
  });
});
