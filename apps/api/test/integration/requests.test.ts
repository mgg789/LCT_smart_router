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

interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

interface RequestBody {
  request: {
    id: string;
    version: number;
    lifecycle: string;
    assignmentState: string;
    windowStartAt: number;
    windowEndAt: number;
    priority: string;
    requiredSkill: string;
    serviceDurationSec: number;
    needsGeocoding: boolean;
    lat: number | null;
    lon: number | null;
  };
}

const DAY = 1789459200; // a fixed absolute second, so tests never depend on "now"
const HOUR = 3600;

/**
 * Acceptance scenarios for the request lifecycle, from context/36 sections 3, 4 and 13
 * and context/42 DF-04 and DF-05.
 */
describe('request lifecycle', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let clientToken: string;
  let dispatcherToken: string;
  let clientEmail: string;
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

  const prepare = async (overrides: Record<string, unknown> = {}) => {
    const response = await call('POST', '/api/v1/client/requests', clientToken, {
      operationId: randomUUID(),
      contactName: 'Test Customer',
      addressText: 'Москва, ул. Тестовая, д. 1',
      lat: 55.76,
      lon: 37.64,
      workType: 'router_replacement',
      windowStartAt: DAY + 10 * HOUR,
      windowEndAt: DAY + 12 * HOUR,
      urgent: false,
      ...overrides,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const body = (await response.json()) as RequestBody;
    requestIds.push(body.request.id);
    return body.request;
  };

  const submit = async (id: string, expectedVersion: number) =>
    call('POST', `/api/v1/client/requests/${id}/submit`, clientToken, {
      operationId: randomUUID(),
      expectedVersion,
    });

  /** How many requests this customer currently has in an active stage. */
  const activeRequestCount = async (): Promise<number> => {
    const response = await call('GET', '/api/v1/client/requests', clientToken);
    return ((await response.json()) as { requests: unknown[] }).requests.length;
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

    clientEmail = `${unique('requests')}@example.test`;
    const codeResponse = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: clientEmail }),
    });
    const { devCode } = (await codeResponse.json()) as { devCode: string };
    const verify = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: clientEmail, code: devCode, role: 'client' }),
    });
    clientToken = ((await verify.json()) as { token: string }).token;

    const dispatcher = await fetch(`${baseUrl}/api/v1/auth/dispatcher/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      }),
    });
    dispatcherToken = ((await dispatcher.json()) as { token: string }).token;
  });

  after(async () => {
    if (requestIds.length > 0) {
      await prisma.requestConditionHistory.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.requestFact.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.notificationIntent.deleteMany({
        where: { businessEventKey: { in: requestIds.map((id) => `request_received:${id}`) } },
      });
      await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
    }
    await prisma.account.deleteMany({ where: { email: clientEmail } });
    await prisma.$disconnect();
    await app?.close();
  });

  it('derives skill, duration and priority from the type of work', async () => {
    const outage = await prepare({ workType: 'outage' });
    assert.equal(outage.requiredSkill, 'emergency');
    assert.equal(outage.priority, 'urgent');
    assert.ok(outage.serviceDurationSec > 0);

    const replacement = await prepare({ workType: 'router_replacement' });
    assert.equal(replacement.requiredSkill, 'connection');
    assert.equal(replacement.priority, 'normal');
  });

  it("raises the priority on the customer's urgency but never lowers it", async () => {
    const urgentByCustomer = await prepare({ workType: 'monitoring', urgent: true });
    assert.equal(urgentByCustomer.priority, 'urgent');

    // An outage stays urgent even when the customer did not tick the box.
    const outage = await prepare({ workType: 'outage', urgent: false });
    assert.equal(outage.priority, 'urgent');
  });

  it('marks a request without coordinates instead of inventing them', async () => {
    const withoutPoint = await prepare({ lat: null, lon: null });
    assert.equal(withoutPoint.needsGeocoding, true);
    assert.equal(withoutPoint.lat, null);
  });

  it('keeps a draft out of distribution until it is confirmed', async () => {
    const draft = await prepare();
    assert.equal(draft.lifecycle, 'draft');

    // No mail for something the customer has not sent yet (context/42 DF-04).
    const intents = await prisma.notificationIntent.findMany({
      where: { businessEventKey: `request_received:${draft.id}` },
    });
    assert.equal(intents.length, 0);

    const response = await submit(draft.id, draft.version);
    assert.equal(response.status, 201);
    const submitted = ((await response.json()) as RequestBody).request;
    assert.equal(submitted.lifecycle, 'submitted');
    assert.equal(submitted.assignmentState, 'pending');

    const afterSubmit = await prisma.notificationIntent.findMany({
      where: { businessEventKey: `request_received:${draft.id}` },
    });
    assert.equal(afterSubmit.length, 1);
    assert.equal(afterSubmit[0]?.category, 'request_received');
    // Recorded, not sent: transport belongs to the SMTP-gateway, which is not in this
    // build, and pretending otherwise would be a lie about delivery.
    assert.equal(afterSubmit[0]?.state, 'pending_submission');
  });

  it('gives every submitted request its own arrival order', async () => {
    const first = await prepare();
    const second = await prepare();
    await submit(first.id, first.version);
    await submit(second.id, second.version);

    const rows = await prisma.request.findMany({
      where: { id: { in: [first.id, second.id] } },
      orderBy: { arrivalOrder: 'asc' },
    });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.arrivalOrder, rows[1]?.arrivalOrder);
    assert.equal(rows[0]?.id, first.id, 'arrival order must follow the order of submission');
  });

  it('does not create a second request when the confirmation is repeated', async () => {
    const draft = await prepare();
    const operationId = randomUUID();
    const payload = { operationId, expectedVersion: draft.version };

    const first = await call(
      'POST',
      `/api/v1/client/requests/${draft.id}/submit`,
      clientToken,
      payload,
    );
    const second = await call(
      'POST',
      `/api/v1/client/requests/${draft.id}/submit`,
      clientToken,
      payload,
    );
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);

    const intents = await prisma.notificationIntent.findMany({
      where: { businessEventKey: `request_received:${draft.id}` },
    });
    assert.equal(intents.length, 1, 'one submission is one mail event');
  });

  it('replaces the window on the same request and keeps the old one only in history', async () => {
    const draft = await prepare();
    const submitted = ((await (await submit(draft.id, draft.version)).json()) as RequestBody)
      .request;
    const activeBefore = await activeRequestCount();

    const response = await call(
      'POST',
      `/api/v1/client/requests/${draft.id}/reschedule`,
      clientToken,
      {
        operationId: randomUUID(),
        expectedVersion: submitted.version,
        windowStartAt: DAY + 14 * HOUR,
        windowEndAt: DAY + 16 * HOUR,
      },
    );
    assert.equal(response.status, 201);
    const rescheduled = ((await response.json()) as RequestBody).request;

    assert.equal(rescheduled.id, draft.id, 'a reschedule keeps the same request id');
    assert.equal(rescheduled.windowStartAt, DAY + 14 * HOUR);
    // The previous assignment does not confirm the new conditions.
    assert.equal(rescheduled.assignmentState, 'pending');

    // The whole point of SL3: one request id, one live window. A copy of the request in
    // the desired window, or the old one kept alongside it, would be a second promise to
    // the customer (context/36 section 4).
    assert.equal(
      await activeRequestCount(),
      activeBefore,
      'a reschedule must not create a second active visit',
    );

    const history = await prisma.requestConditionHistory.findMany({
      where: { requestId: draft.id },
    });
    assert.ok(history.length >= 1);
    assert.equal(
      (history[0]?.previous as { windowStartAt: number }).windowStartAt,
      DAY + 10 * HOUR,
    );
  });

  it('reports a conflict when the screen the customer confirmed is out of date', async () => {
    const draft = await prepare();
    const submitted = ((await (await submit(draft.id, draft.version)).json()) as RequestBody)
      .request;

    // The dispatcher changes the window while the customer looks at the old screen.
    await call('PATCH', `/api/v1/dispatch/requests/${draft.id}`, dispatcherToken, {
      operationId: randomUUID(),
      expectedVersion: submitted.version,
      windowStartAt: DAY + 9 * HOUR,
      windowEndAt: DAY + 11 * HOUR,
    });

    const stale = await call(
      'POST',
      `/api/v1/client/requests/${draft.id}/reschedule`,
      clientToken,
      {
        operationId: randomUUID(),
        expectedVersion: submitted.version,
        windowStartAt: DAY + 18 * HOUR,
        windowEndAt: DAY + 20 * HOUR,
      },
    );

    assert.equal(stale.status, 409);
    const body = (await stale.json()) as ErrorBody;
    assert.equal(body.error.code, 'VERSION_CONFLICT');
    assert.equal(body.error.details.expectedVersion, submitted.version);
    assert.ok(typeof body.error.details.currentVersion === 'number');

    // The dispatcher's change stands: a stale confirmation does not overwrite it.
    const stored = await prisma.request.findUniqueOrThrow({ where: { id: draft.id } });
    assert.equal(Number(stored.windowStartAt), DAY + 9 * HOUR);
  });

  it('closes ordinary changes once the engineer has started the work', async () => {
    const draft = await prepare();
    await submit(draft.id, draft.version);

    // The fact itself is recorded by the engineer contour; here it is set directly so the
    // rule can be tested on its own.
    await prisma.request.update({
      where: { id: draft.id },
      data: {
        lifecycle: 'in_progress',
        startedAt: BigInt(DAY + 10 * HOUR),
        version: { increment: 1 },
      },
    });
    const current = await prisma.request.findUniqueOrThrow({ where: { id: draft.id } });

    for (const attempt of [
      call('POST', `/api/v1/client/requests/${draft.id}/reschedule`, clientToken, {
        operationId: randomUUID(),
        expectedVersion: current.version,
        windowStartAt: DAY + 18 * HOUR,
        windowEndAt: DAY + 20 * HOUR,
      }),
      call('PATCH', `/api/v1/dispatch/requests/${draft.id}`, dispatcherToken, {
        operationId: randomUUID(),
        expectedVersion: current.version,
        urgent: true,
      }),
      call('POST', `/api/v1/dispatch/requests/${draft.id}/cancel`, dispatcherToken, {
        operationId: randomUUID(),
        expectedVersion: current.version,
      }),
    ]) {
      const response = await attempt;
      assert.equal(response.status, 409);
      assert.equal(((await response.json()) as ErrorBody).error.code, 'WORK_ALREADY_STARTED');
    }
  });

  it('cancels as a state change, not a deletion', async () => {
    const draft = await prepare();
    const submitted = ((await (await submit(draft.id, draft.version)).json()) as RequestBody)
      .request;

    const response = await call(
      'POST',
      `/api/v1/dispatch/requests/${draft.id}/cancel`,
      dispatcherToken,
      { operationId: randomUUID(), expectedVersion: submitted.version, reason: 'customer called' },
    );
    assert.equal(response.status, 201);
    const cancelled = ((await response.json()) as RequestBody).request;
    assert.equal(cancelled.lifecycle, 'cancelled');

    const stored = await prisma.request.findUnique({ where: { id: draft.id } });
    assert.ok(stored, 'the record must survive cancellation');
    assert.notEqual(stored.cancelledAt, null);
  });

  it("does not show one customer another customer's request", async () => {
    const draft = await prepare();
    const otherEmail = `${unique('other')}@example.test`;
    const codeResponse = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: otherEmail }),
    });
    const { devCode } = (await codeResponse.json()) as { devCode: string };
    const verify = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: otherEmail, code: devCode, role: 'client' }),
    });
    const otherToken = ((await verify.json()) as { token: string }).token;

    const response = await call('GET', `/api/v1/client/requests/${draft.id}`, otherToken);
    // Reported as absent, not forbidden: confirming that someone else's request exists is
    // itself a disclosure.
    assert.equal(response.status, 404);

    await prisma.account.deleteMany({ where: { email: otherEmail } });
  });

  it('rejects a window that ends before it starts', async () => {
    const response = await call('POST', '/api/v1/client/requests', clientToken, {
      operationId: randomUUID(),
      contactName: 'Test Customer',
      addressText: 'Москва, ул. Тестовая, д. 2',
      workType: 'monitoring',
      windowStartAt: DAY + 12 * HOUR,
      windowEndAt: DAY + 10 * HOUR,
    });
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'VALIDATION_FAILED');
  });
});
