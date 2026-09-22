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
    normProfileCode: string;
    normativeTravelDurationSec: number;
    technicalDurationSec: number;
    documentationDurationSec: number;
    serviceDurationSec: number;
    actualDurationSec: number | null;
    durationVarianceSec: number | null;
    expectedCompletionAt: number | null;
    continuationAvailableAt: number | null;
    overrunDetectedAt: number | null;
    needsGeocoding: boolean;
    lat: number | null;
    lon: number | null;
    requiredEquipment: string | null;
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
        where: {
          OR: requestIds.flatMap((id) => [
            { businessEventKey: { startsWith: `request_received:${id}` } },
            { businessEventKey: { startsWith: `visit_change_required:${id}:` } },
            { businessEventKey: { startsWith: `request_rescheduled:${id}:` } },
            { businessEventKey: { startsWith: `engineer_confirmed:${id}` } },
            { businessEventKey: { startsWith: `request_completed:${id}` } },
            { businessEventKey: { startsWith: `request_cancelled:${id}` } },
          ]),
        },
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
    assert.equal(outage.normProfileCode, 'outage_tkd');
    assert.equal(outage.normativeTravelDurationSec, 1200);
    assert.equal(outage.technicalDurationSec, 4800);
    assert.equal(outage.documentationDurationSec, 0);
    assert.equal(outage.serviceDurationSec, 4800);
    assert.equal(outage.actualDurationSec, null);
    assert.equal(outage.durationVarianceSec, null);
    assert.equal(outage.expectedCompletionAt, null);
    assert.equal(outage.continuationAvailableAt, null);
    assert.equal(outage.overrunDetectedAt, null);

    const tightOutage = await prepare({
      workType: 'outage',
      windowStartAt: DAY + 17 * HOUR + 45 * 60,
      windowEndAt: DAY + 18 * HOUR + 45 * 60,
    });
    assert.equal(tightOutage.windowEndAt - tightOutage.windowStartAt, 4800);

    const replacement = await prepare({ workType: 'router_replacement' });
    assert.equal(replacement.requiredSkill, 'connection');
    assert.equal(replacement.priority, 'normal');
    assert.equal(replacement.normProfileCode, 'equipment_order');
    assert.equal(replacement.normativeTravelDurationSec, 1200);
    assert.equal(replacement.technicalDurationSec, 600);
    assert.equal(replacement.documentationDurationSec, 600);
    assert.equal(replacement.serviceDurationSec, 1200);
    assert.equal(replacement.requiredEquipment, 'router');

    const withoutEquipment = await prepare({
      workType: 'router_replacement',
      requiredEquipment: null,
    });
    assert.equal(withoutEquipment.requiredEquipment, null);
  });

  it("raises the priority on the customer's urgency but never lowers it", async () => {
    const urgentByCustomer = await prepare({ workType: 'monitoring', urgent: true });
    assert.equal(urgentByCustomer.priority, 'urgent');

    // An outage stays urgent even when the customer did not tick the box.
    const outage = await prepare({ workType: 'outage', urgent: false });
    assert.equal(outage.priority, 'urgent');
  });

  it('accepts normal and urgent unplanned work directly from the dispatcher', async () => {
    for (const urgent of [false, true]) {
      const response = await call('POST', '/api/v1/dispatch/requests', dispatcherToken, {
        operationId: randomUUID(),
        clientEmail,
        contactName: 'Unplanned Customer',
        addressText: 'Москва, ул. Внеплановая, д. 1',
        lat: 55.75,
        lon: 37.61,
        workType: 'monitoring',
        windowStartAt: DAY + 13 * HOUR,
        windowEndAt: DAY + 15 * HOUR,
        urgent,
      });
      assert.equal(response.status, 201, await response.clone().text());
      const request = ((await response.json()) as RequestBody).request;
      requestIds.push(request.id);
      assert.equal(request.lifecycle, 'submitted');
      assert.equal(request.assignmentState, 'pending');
      assert.equal(request.priority, urgent ? 'urgent' : 'normal');
    }
  });

  it('accepts a compact dispatcher request before customer identity is known', async () => {
    const response = await call('POST', '/api/v1/dispatch/requests', dispatcherToken, {
      operationId: randomUUID(),
      addressText: 'Москва, ул. Новая, д. 2',
      workType: 'monitoring',
      windowStartAt: DAY + 9 * HOUR,
      windowEndAt: DAY + 11 * HOUR,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const request = ((await response.json()) as RequestBody).request;
    requestIds.push(request.id);

    const stored = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(stored.clientAccountId, null);
    assert.equal(stored.contactName, null);
    assert.equal(stored.lifecycle, 'submitted');
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
    const [entry] = history;
    assert.ok(entry, 'moving the window must leave a history entry');
    assert.equal((entry.previous as { windowStartAt: number }).windowStartAt, DAY + 10 * HOUR);

    // The customer moved the window themselves, so the letter confirms the new time. The
    // intent is recorded, not delivered: transport belongs to the SMTP-gateway
    // (context/36 section 10).
    const changeIntents = await prisma.notificationIntent.findMany({
      where: {
        businessEventKey: `request_rescheduled:${draft.id}:${DAY + 14 * HOUR}:${DAY + 16 * HOUR}`,
      },
    });
    assert.equal(changeIntents.length, 1);
    assert.equal(changeIntents[0]?.category, 'request_rescheduled');
    assert.equal(changeIntents[0]?.state, 'pending_submission');
  });

  it('confirms a customer-initiated move once per proposed window', async () => {
    const draft = await prepare();
    const submitted = ((await (await submit(draft.id, draft.version)).json()) as RequestBody)
      .request;
    const keyOf = (start: number, end: number) => `request_rescheduled:${draft.id}:${start}:${end}`;
    const intentCount = async (key: string) =>
      (await prisma.notificationIntent.findMany({ where: { businessEventKey: key } })).length;

    const first = await call(
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
    assert.equal(first.status, 201, await first.clone().text());
    assert.equal(await intentCount(keyOf(DAY + 14 * HOUR, DAY + 16 * HOUR)), 1);

    // Repeating the same change is the same transition, not a second letter
    // (context/36 section 10).
    const current = ((await first.json()) as RequestBody).request;
    const repeat = await call(
      'POST',
      `/api/v1/client/requests/${draft.id}/reschedule`,
      clientToken,
      {
        operationId: randomUUID(),
        expectedVersion: current.version,
        windowStartAt: DAY + 14 * HOUR,
        windowEndAt: DAY + 16 * HOUR,
      },
    );
    assert.equal(repeat.status, 201, await repeat.clone().text());
    assert.equal(await intentCount(keyOf(DAY + 14 * HOUR, DAY + 16 * HOUR)), 1);

    // A different proposed window is a new confirmation to the customer.
    const moved = ((await repeat.json()) as RequestBody).request;
    const other = await call(
      'POST',
      `/api/v1/client/requests/${draft.id}/reschedule`,
      clientToken,
      {
        operationId: randomUUID(),
        expectedVersion: moved.version,
        windowStartAt: DAY + 18 * HOUR,
        windowEndAt: DAY + 20 * HOUR,
      },
    );
    assert.equal(other.status, 201, await other.clone().text());
    assert.equal(await intentCount(keyOf(DAY + 18 * HOUR, DAY + 20 * HOUR)), 1);
  });

  it('asks the customer to re-agree when the dispatcher moves the window', async () => {
    const draft = await prepare();
    const submitted = ((await (await submit(draft.id, draft.version)).json()) as RequestBody)
      .request;
    const keyOf = (start: number, end: number) =>
      `visit_change_required:${draft.id}:${start}:${end}`;
    const intentCount = async (key: string) =>
      (await prisma.notificationIntent.findMany({ where: { businessEventKey: key } })).length;

    // The office takes the agreed window away, so the customer gets the letter with the
    // two answers: pick a new time or cancel (card #65, 2026-09-20 decision).
    const moved = await call('PATCH', `/api/v1/dispatch/requests/${draft.id}`, dispatcherToken, {
      operationId: randomUUID(),
      expectedVersion: submitted.version,
      windowStartAt: DAY + 9 * HOUR,
      windowEndAt: DAY + 11 * HOUR,
    });
    assert.equal(moved.status, 200, await moved.clone().text());
    assert.equal(await intentCount(keyOf(DAY + 9 * HOUR, DAY + 11 * HOUR)), 1);

    // An edit that keeps the agreed window asks no new question.
    const current = ((await moved.json()) as RequestBody).request;
    const urgentOnly = await call(
      'PATCH',
      `/api/v1/dispatch/requests/${draft.id}`,
      dispatcherToken,
      { operationId: randomUUID(), expectedVersion: current.version, urgent: true },
    );
    assert.equal(urgentOnly.status, 200, await urgentOnly.clone().text());
    assert.equal(await intentCount(keyOf(DAY + 9 * HOUR, DAY + 11 * HOUR)), 1);
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

    // The customer learns the work will not happen from sys, not from silence.
    const cancelIntents = await prisma.notificationIntent.findMany({
      where: { businessEventKey: `request_cancelled:${draft.id}` },
    });
    assert.equal(cancelIntents.length, 1);
    assert.equal(cancelIntents[0]?.category, 'request_cancelled');
  });

  it("lets a customer cancel their own request and hides another customer's", async () => {
    const draft = await prepare();
    const submitted = ((await (await submit(draft.id, draft.version)).json()) as RequestBody)
      .request;
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

    // Someone else's request is reported as absent, not forbidden: confirming that it
    // exists is itself a disclosure.
    const foreign = await call('POST', `/api/v1/client/requests/${draft.id}/cancel`, otherToken, {
      operationId: randomUUID(),
      expectedVersion: submitted.version,
    });
    assert.equal(foreign.status, 404);

    const own = await call('POST', `/api/v1/client/requests/${draft.id}/cancel`, clientToken, {
      operationId: randomUUID(),
      expectedVersion: submitted.version,
      reason: 'plans changed',
    });
    assert.equal(own.status, 201, await own.clone().text());
    assert.equal(((await own.json()) as RequestBody).request.lifecycle, 'cancelled');

    await prisma.account.deleteMany({ where: { email: otherEmail } });
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

  it('stops event letters when the customer silences them, but never login codes', async () => {
    const draft = await prepare();
    await submit(draft.id, draft.version);
    const receivedIntents = async (id: string) =>
      prisma.notificationIntent.findMany({
        where: { businessEventKey: `request_received:${id}` },
      });
    assert.equal((await receivedIntents(draft.id)).length, 1);

    const off = await call('PATCH', '/api/v1/client/notifications', clientToken, {
      operationId: randomUUID(),
      enabled: false,
    });
    assert.equal(off.status, 200, await off.clone().text());

    // A new request still enters distribution, but writes no letter.
    const silenced = await prepare();
    await submit(silenced.id, silenced.version);
    assert.equal((await receivedIntents(silenced.id)).length, 0);

    // A way in must not be silenceable: the login-code letter still goes out.
    const codeResponse = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: clientEmail }),
    });
    assert.equal(codeResponse.status, 201);
    assert.ok(((await codeResponse.json()) as { devCode?: string }).devCode !== undefined);

    const on = await call('PATCH', '/api/v1/client/notifications', clientToken, {
      operationId: randomUUID(),
      enabled: true,
    });
    assert.equal(on.status, 200, await on.clone().text());
    const resubscribed = await prepare();
    await submit(resubscribed.id, resubscribed.version);
    assert.equal((await receivedIntents(resubscribed.id)).length, 1);
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
