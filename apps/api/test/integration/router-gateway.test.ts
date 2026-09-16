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
import { ExecutionOverrunCoordinator } from '../../src/orchestrator/facts';
import type { RouterTaskSnapshot } from '../../src/routing/mount-data-eng';
import { createTestClient, databaseUrl, unique } from '../support/database';
import { buildRouterResult } from '../support/router-result';

interface AcceptanceBody {
  accepted: boolean;
  reason?: string;
  detail?: string;
  planRevision?: number;
}

const HOUR = 3600;

/**
 * Acceptance scenarios for the ROUTER-gateway, from context/33 section 7 and the checks
 * of context/36 section 13.
 *
 * Router Core does not exist yet, so results are built from the contract. That is the
 * point of testing the gateway separately: every rule about *whether* a result becomes the
 * working plan can be verified before the thing that produces results is written.
 */
describe('router gateway', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;
  let clientToken: string;
  let engineerToken: string;
  let engineerId: string;
  const emails: string[] = [];
  const engineerIds: string[] = [];
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

  const publishedHash = async (): Promise<string> => {
    const response = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    return ((await response.json()) as { inputHash: string }).inputHash;
  };

  const publishedPublicationId = async (): Promise<string> => {
    const response = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    return ((await response.json()) as { publicationId: string }).publicationId;
  };

  const publishedSnapshot = async (): Promise<{
    publicationId: string;
    trigger: string;
    snapshot: RouterTaskSnapshot;
  }> => {
    const response = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    const body = (await response.json()) as {
      publicationId: string;
      trigger: string;
      payload: string;
    };
    return {
      publicationId: body.publicationId,
      trigger: body.trigger,
      snapshot: JSON.parse(body.payload) as RouterTaskSnapshot,
    };
  };

  /** Creates and confirms a request, which also republishes the task. */
  const submitRequest = async (
    workType = 'connection_request',
  ): Promise<{ id: string; lat: number; lon: number }> => {
    const prepared = await call('POST', '/api/v1/client/requests', clientToken, {
      operationId: randomUUID(),
      contactName: 'Gateway Customer',
      addressText: 'Москва, ул. Тестовая, д. 7',
      lat: 55.78,
      lon: 37.66,
      workType,
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

  const feed = async (result: unknown, contextVersion: string | null = null) => {
    const packageWithIdentity = result as {
      status?: string;
      input_publication_id?: string | null;
    };
    if (packageWithIdentity.status === 'ready' && !packageWithIdentity.input_publication_id) {
      packageWithIdentity.input_publication_id = await publishedPublicationId();
    }
    const response = await call('POST', '/api/v1/dispatch/debug/router-result', dispatcherToken, {
      operationId: randomUUID(),
      result,
      activeContextVersion: contextVersion,
    });
    const body = (await response.json()) as AcceptanceBody;
    if (body.reason === 'SNAPSHOT_STALE') {
      // Surface both hashes: a stale answer usually means the task was republished between
      // building the result and feeding it, and a bare code would hide that.
      const sent = (result as { input_hash?: string }).input_hash;
      body.detail = `${body.detail} (sent ${sent}, current ${await publishedHash()})`;
    }
    return { status: response.status, body };
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

    const engineerEmail = `${unique('gw-eng')}@example.test`;
    emails.push(engineerEmail);
    const created = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email: engineerEmail,
      displayName: 'Gateway Engineer',
      skills: ['connection', 'emergency'],
      transportType: 'car',
      homeLat: 55.75,
      homeLon: 37.62,
    });
    engineerId = ((await created.json()) as { engineer: { id: string } }).engineer.id;
    engineerIds.push(engineerId);

    await call('POST', `/api/v1/dispatch/engineers/${engineerId}/workday`, dispatcherToken, {
      operationId: randomUUID(),
      workDate: new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.APP_TIME_ZONE ?? 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
      shiftStartAt: now() - HOUR,
      shiftEndAt: now() + 9 * HOUR,
    });
    engineerToken = await signIn(engineerEmail, 'engineer');
  });

  after(async () => {
    await prisma.appliedPlanCurrent.deleteMany({});
    await prisma.appliedPlan.deleteMany({});
    await prisma.routerResult.deleteMany({});
    await prisma.alert.deleteMany({});
    if (requestIds.length > 0) {
      await prisma.requestFact.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.requestConditionHistory.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.notificationIntent.deleteMany({});
      await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
    }
    if (engineerIds.length > 0) {
      await prisma.engineerDay.deleteMany({ where: { engineerId: { in: engineerIds } } });
      await prisma.engineer.deleteMany({ where: { id: { in: engineerIds } } });
    }
    if (emails.length > 0) {
      await prisma.account.deleteMany({ where: { email: { in: emails } } });
    }
    await prisma.controlState.update({
      where: { id: 'singleton' },
      data: { mode: 'auto', frozenPlanId: null },
    });
    await prisma.$disconnect();
    await app?.close();
  });

  it('refuses a result that belongs to a snapshot which is no longer published', async () => {
    const request = await submitRequest();
    const result = buildRouterResult({
      resultId: unique('result'),
      inputHash: 'a-hash-from-an-older-task',
      contextVersion: 'ctx-1',
      planningAsOf: now(),
      assigned: [
        {
          requestId: request.id,
          engineerId,
          lat: request.lat,
          lon: request.lon,
          startAt: now() + HOUR,
          durationSec: 1800,
        },
      ],
    });

    const { body } = await feed(result, 'ctx-1');
    assert.equal(body.accepted, false);
    // Not a failure: the answer is about an earlier task and a newer one is on its way.
    assert.equal(body.reason, 'SNAPSHOT_STALE', body.detail);
  });

  it('refuses matching bytes attributed to a different publication', async () => {
    const request = await submitRequest();
    const result = buildRouterResult({
      resultId: unique('result'),
      inputPublicationId: 'superseded-publication',
      inputHash: await publishedHash(),
      contextVersion: 'ctx-1',
      planningAsOf: now(),
      assigned: [
        {
          requestId: request.id,
          engineerId,
          lat: request.lat,
          lon: request.lon,
          startAt: now() + HOUR,
          durationSec: 1800,
        },
      ],
    });

    const { body } = await feed(result, 'ctx-1');
    assert.equal(body.accepted, false);
    assert.equal(body.reason, 'SNAPSHOT_STALE', body.detail);
    assert.match(body.detail ?? '', /publication/i);
  });

  it('refuses a result computed under a context that is no longer active', async () => {
    const request = await submitRequest();
    const result = buildRouterResult({
      resultId: unique('result'),
      inputHash: await publishedHash(),
      contextVersion: 'ctx-old',
      planningAsOf: now(),
      assigned: [
        {
          requestId: request.id,
          engineerId,
          lat: request.lat,
          lon: request.lon,
          startAt: now() + HOUR,
          durationSec: 1800,
        },
      ],
    });

    const { body } = await feed(result, 'ctx-now');
    assert.equal(body.accepted, false);
    assert.equal(body.reason, 'RESULT_NOT_APPLICABLE', body.detail);
  });

  it('refuses a finished result whose main plan is not usable', async () => {
    const request = await submitRequest();
    const resultId = unique('result');
    const result = buildRouterResult({
      resultId,
      inputHash: await publishedHash(),
      contextVersion: 'ctx-1',
      planningAsOf: now(),
      isUsable: false,
      assigned: [
        {
          requestId: request.id,
          engineerId,
          lat: request.lat,
          lon: request.lon,
          startAt: now() + HOUR,
          durationSec: 1800,
        },
      ],
    });

    const { body } = await feed(result, 'ctx-1');
    assert.equal(body.accepted, false);
    assert.equal(body.reason, 'RESULT_NOT_APPLICABLE', body.detail);
    // Kept, so the refusal can be explained afterwards. Looked up by its own id rather
    // than as "the most recent": `receivedAt` is whole seconds, and several results in one
    // second have no order between them.
    const stored = await prisma.routerResult.findUniqueOrThrow({ where: { resultId } });
    assert.equal(stored.accepted, false);
    assert.equal(stored.rejectionCode, 'RESULT_NOT_APPLICABLE');
  });

  it('applies a valid result as a new immutable plan revision', async () => {
    const request = await submitRequest();
    const resultId = unique('result');
    const { body } = await feed(
      buildRouterResult({
        resultId,
        inputHash: await publishedHash(),
        contextVersion: 'ctx-1',
        planningAsOf: now(),
        assigned: [
          {
            requestId: request.id,
            engineerId,
            lat: request.lat,
            lon: request.lon,
            startAt: now() + HOUR,
            durationSec: 1800,
          },
        ],
      }),
      'ctx-1',
    );

    assert.equal(body.accepted, true, body.detail);
    assert.ok(body.planRevision);

    const stored = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(stored.assignmentState, 'assigned');
    // The business stage is untouched: distribution and execution are different things.
    assert.equal(stored.lifecycle, 'submitted');

    const intent = await prisma.notificationIntent.findUnique({
      where: { businessEventKey: `engineer_assigned:${request.id}:${engineerId}` },
    });
    assert.ok(intent, 'accepting an assignment is a business transition with its own letter');
  });

  it('does not apply the same result twice', async () => {
    const request = await submitRequest();
    const resultId = unique('result');
    const result = buildRouterResult({
      resultId,
      inputHash: await publishedHash(),
      contextVersion: 'ctx-1',
      planningAsOf: now(),
      assigned: [
        {
          requestId: request.id,
          engineerId,
          lat: request.lat,
          lon: request.lon,
          startAt: now() + HOUR,
          durationSec: 1800,
        },
      ],
    });

    const first = await feed(result, 'ctx-1');
    assert.equal(first.body.accepted, true, first.body.detail);
    const revisionsAfterFirst = await prisma.appliedPlan.count();

    const second = await feed(result, 'ctx-1');
    assert.equal(second.body.accepted, false);
    // Re-reading a result does not apply it again, does not return completed work and does
    // not repeat a letter (context/33 section 7).
    assert.equal(second.body.reason, 'ALREADY_APPLIED', second.body.detail);
    assert.equal(await prisma.appliedPlan.count(), revisionsAfterFirst);
  });

  it('will not distribute work that has already started', async () => {
    const request = await submitRequest();
    const accepted = await feed(
      buildRouterResult({
        resultId: unique('result'),
        inputHash: await publishedHash(),
        contextVersion: 'ctx-1',
        planningAsOf: now(),
        assigned: [
          {
            requestId: request.id,
            engineerId,
            lat: request.lat,
            lon: request.lon,
            startAt: now() + HOUR,
            durationSec: 1800,
          },
        ],
      }),
      'ctx-1',
    );
    assert.equal(accepted.body.accepted, true, accepted.body.detail);

    const started = await call(
      'POST',
      `/api/v1/engineer/requests/${request.id}/facts`,
      engineerToken,
      { operationId: randomUUID(), kind: 'started' },
    );
    assert.equal(started.status, 201, await started.clone().text());

    const later = await feed(
      buildRouterResult({
        resultId: unique('result'),
        inputHash: await publishedHash(),
        contextVersion: 'ctx-1',
        planningAsOf: now(),
        assigned: [
          {
            requestId: request.id,
            engineerId,
            lat: request.lat,
            lon: request.lon,
            startAt: now() + 2 * HOUR,
            durationSec: 1800,
          },
        ],
      }),
      'ctx-1',
    );

    assert.equal(later.body.accepted, false);
    assert.equal(later.body.reason, 'RESULT_NOT_APPLICABLE', later.body.detail);
    // sys does not repair the plan with an optimiser of its own; it declines to apply it.
    assert.match(later.body.detail ?? '', /already started/i);
    const cleanup = await call(
      'POST',
      `/api/v1/engineer/requests/${request.id}/facts`,
      engineerToken,
      { operationId: randomUUID(), kind: 'finished' },
    );
    assert.equal(cleanup.status, 201, await cleanup.clone().text());
  });

  describe('execution facts', () => {
    it('keeps arrival and start as separate events', async () => {
      const request = await submitRequest();
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );

      const arrived = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'arrived_blocked', note: 'no access to the riser' },
      );
      assert.equal(arrived.status, 201);

      // On site but unable to begin: the work has not started (context/42 DF-07).
      const afterArrival = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      assert.equal(afterArrival.lifecycle, 'submitted');
      assert.equal(afterArrival.startedAt, null);
    });

    it('refuses to finish work that was never started', async () => {
      const request = await submitRequest();
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );

      const response = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'finished' },
      );
      // A completion inferred from nothing would be fabricated history.
      assert.equal(response.status, 422);
    });

    it('does not let an engineer mark work that is not in their plan', async () => {
      const request = await submitRequest();
      const response = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'started' },
      );
      // No accepted plan assigns it to them, so there is nothing to report.
      assert.ok(response.status === 403 || response.status === 404);
    });

    it('records when it happened separately from when it was stored', async () => {
      const request = await submitRequest();
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );

      const reportedAt = now() - 600;
      await call('POST', `/api/v1/engineer/requests/${request.id}/facts`, engineerToken, {
        operationId: randomUUID(),
        kind: 'started',
        occurredAt: reportedAt,
      });

      const fact = await prisma.requestFact.findFirstOrThrow({
        where: { requestId: request.id, kind: 'started' },
      });
      assert.equal(Number(fact.occurredAt), reportedAt);
      assert.ok(fact.recordedAt > fact.occurredAt, 'the two moments are not interchangeable');
      const cleanup = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'finished', occurredAt: now() },
      );
      assert.equal(cleanup.status, 201, await cleanup.clone().text());
    });

    it('replans from the task location when an engineer finishes at least 15 minutes early', async () => {
      const request = await submitRequest();
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );
      const stored = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      const finishAt = now();
      const startedAt = finishAt - (stored.serviceDurationSec - 15 * 60);

      const started = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'started', occurredAt: startedAt },
      );
      assert.equal(started.status, 201, await started.clone().text());
      const afterStart = await publishedSnapshot();
      assert.equal(afterStart.trigger, 'request.execution_started');
      const busyEngineer = afterStart.snapshot.engineers.find(
        (engineer) => engineer.engineer_id === engineerId,
      );
      assert.deepEqual(busyEngineer?.start_location, { lat: request.lat, lon: request.lon });
      assert.equal(busyEngineer?.available_from, startedAt + stored.serviceDurationSec);

      const finished = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'finished', occurredAt: finishAt },
      );
      assert.equal(finished.status, 201, await finished.clone().text());
      const finishedBody = (await finished.json()) as {
        request: { actualDurationSec: number; durationVarianceSec: number };
      };
      assert.equal(finishedBody.request.actualDurationSec, stored.serviceDurationSec - 15 * 60);
      assert.equal(finishedBody.request.durationVarianceSec, -15 * 60);

      const afterFinish = await publishedSnapshot();
      assert.notEqual(afterFinish.publicationId, afterStart.publicationId);
      assert.equal(afterFinish.trigger, 'request.execution_variance');
      assert.equal(
        afterFinish.snapshot.engineers.find((engineer) => engineer.engineer_id === engineerId)
          ?.available_from,
        finishAt,
      );
    });

    it('keeps the planned continuation for a finish inside the variance thresholds', async () => {
      const request = await submitRequest();
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );
      const stored = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      const finishAt = now();
      const startedAt = finishAt - (stored.serviceDurationSec - 14 * 60);
      await call('POST', `/api/v1/engineer/requests/${request.id}/facts`, engineerToken, {
        operationId: randomUUID(),
        kind: 'started',
        occurredAt: startedAt,
      });
      const publicationAfterStart = await publishedPublicationId();

      const finished = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'finished', occurredAt: finishAt },
      );
      assert.equal(finished.status, 201, await finished.clone().text());
      assert.equal(await publishedPublicationId(), publicationAfterStart);
      const completed = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      assert.equal(
        Number(completed.continuationAvailableAt),
        startedAt + stored.serviceDurationSec,
      );
    });

    it('absorbs a finish exactly 10 minutes late without rebuilding the route', async () => {
      const request = await submitRequest('equipment_order');
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1200,
            },
          ],
        }),
        'ctx-1',
      );
      const stored = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      const finishAt = now();
      const startedAt = finishAt - stored.serviceDurationSec - 10 * 60;
      const started = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'started', occurredAt: startedAt },
      );
      assert.equal(started.status, 201, await started.clone().text());
      const publicationAfterStart = await publishedPublicationId();

      const finished = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'finished', occurredAt: finishAt },
      );
      assert.equal(finished.status, 201, await finished.clone().text());
      assert.equal(await publishedPublicationId(), publicationAfterStart);
      const completed = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      assert.equal(
        Number(completed.continuationAvailableAt),
        startedAt + stored.serviceDurationSec,
      );
    });

    it('withdraws overdue capacity without auto-finishing and restores it on explicit finish', async () => {
      const request = await submitRequest('equipment_order');
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );
      const stored = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      const startedAt = now() - stored.serviceDurationSec - 10 * 60 - 1;
      await call('POST', `/api/v1/engineer/requests/${request.id}/facts`, engineerToken, {
        operationId: randomUUID(),
        kind: 'started',
        occurredAt: startedAt,
      });
      // Keep an unfinished task authoritative even when its start falls just before the
      // current shift horizon. This can happen after a dispatcher corrects a shift or a
      // long task rolls into the next planning horizon.
      await prisma.engineerDay.updateMany({
        where: { engineerId },
        data: { shiftStartAt: BigInt(startedAt + 1) },
      });

      await app.get(ExecutionOverrunCoordinator).runOnce();
      const overdue = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
      assert.equal(overdue.lifecycle, 'in_progress');
      assert.equal(overdue.completedAt, null, 'the threshold must never invent a finish fact');
      assert.ok(overdue.overrunDetectedAt);
      const afterOverrun = await publishedSnapshot();
      assert.equal(afterOverrun.trigger, 'request.execution_overrun');
      assert.equal(
        afterOverrun.snapshot.engineers.some((engineer) => engineer.engineer_id === engineerId),
        false,
      );

      const finished = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'finished', occurredAt: now() },
      );
      assert.equal(finished.status, 201, await finished.clone().text());
      const afterFinish = await publishedSnapshot();
      assert.equal(afterFinish.trigger, 'request.execution_variance');
      assert.equal(
        afterFinish.snapshot.engineers.some((engineer) => engineer.engineer_id === engineerId),
        true,
      );
    });

    it('rejects a finish timestamp earlier than the confirmed start', async () => {
      const request = await submitRequest();
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );
      const startedAt = now();
      await call('POST', `/api/v1/engineer/requests/${request.id}/facts`, engineerToken, {
        operationId: randomUUID(),
        kind: 'started',
        occurredAt: startedAt,
      });
      const response = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'finished', occurredAt: startedAt - 1 },
      );
      assert.equal(response.status, 422);
      const cleanup = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'finished', occurredAt: startedAt },
      );
      assert.equal(cleanup.status, 201, await cleanup.clone().text());
    });
  });

  describe('manual control', () => {
    it('stops applying results and keeps the plan visible', async () => {
      const request = await submitRequest();
      await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );
      const planBefore = await call('GET', '/api/v1/dispatch/plan', dispatcherToken);
      const revisionBefore = ((await planBefore.json()) as { plan: { revision: number } }).plan
        .revision;

      const manual = await call('POST', '/api/v1/dispatch/mode', dispatcherToken, {
        operationId: randomUUID(),
        mode: 'manual',
      });
      assert.equal(manual.status, 201);

      const later = await submitRequest();
      const refused = await feed(
        buildRouterResult({
          resultId: unique('result'),
          inputHash: await publishedHash(),
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: later.id,
              engineerId,
              lat: later.lat,
              lon: later.lon,
              startAt: now() + HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );
      assert.equal(refused.body.accepted, false);
      assert.equal(refused.body.reason, 'MODE_MANUAL', refused.body.detail);

      // The last applied plan stays on screen; the day is not cleared.
      const planAfter = await call('GET', '/api/v1/dispatch/plan', dispatcherToken);
      const after = (await planAfter.json()) as {
        mode: string;
        plan: { revision: number; planAsOf: number };
      };
      assert.equal(after.mode, 'manual');
      assert.equal(after.plan.revision, revisionBefore);
      assert.ok(after.plan.planAsOf > 0, 'the plan carries the moment it describes');

      await call('POST', '/api/v1/dispatch/mode', dispatcherToken, {
        operationId: randomUUID(),
        mode: 'auto',
      });
    });

    it('refuses a manual edit while automatic mode is on', async () => {
      const request = await submitRequest();
      const response = await call('POST', '/api/v1/dispatch/plan/reassign', dispatcherToken, {
        operationId: randomUUID(),
        requestId: request.id,
        engineerId,
      });
      assert.equal(response.status, 409);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        'MODE_AUTO',
      );
    });
  });
});
