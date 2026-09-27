import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import type { Actor } from '../../src/auth';
import { AllExceptionsFilter, SysError } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { ExecutionOverrunCoordinator } from '../../src/orchestrator/facts';
import { McpToolsService } from '../../src/orchestrator/mcp/mcp-tools';
import type { RouterTaskSnapshot } from '../../src/routing/mount-data-eng';
import { RouterClient, type UpdateRouterTechnicalSettings } from '../../src/routing/router-gateway';
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

  it('refuses an in-flight result after a free request window was deferred without publication', async () => {
    const request = await submitRequest();
    const before = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
    const result = buildRouterResult({
      resultId: unique('deferred-window'),
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
    await prisma.request.update({
      where: { id: request.id },
      data: {
        windowStartAt: before.windowStartAt + 86400n,
        windowEndAt: before.windowEndAt + 86400n,
      },
    });
    const { body } = await feed(result, 'ctx-1');
    assert.equal(body.accepted, false);
    assert.equal(body.reason, 'SNAPSHOT_STALE');
    assert.match(body.detail ?? '', /windows changed/);
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
    const request = await submitRequest('connection_request', 'router');
    const resultId = unique('result');
    const inputHash = await publishedHash();
    const { body } = await feed(
      buildRouterResult({
        resultId,
        inputHash,
        contextVersion: 'ctx-1',
        planningAsOf: now(),
        withRoadLeg: true,
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

    const issuedDay = await prisma.engineerDay.findFirstOrThrow({
      where: { engineerId },
      orderBy: { workDate: 'desc' },
    });
    assert.ok(issuedDay.equipmentIssuedAt, 'the first accepted plan freezes the morning issue');
    assert.equal(issuedDay.equipmentRouter, 2, 'one assigned router plus one spare is issued');
    assert.equal(issuedDay.equipmentSetTopBox, 0);
    assert.equal(issuedDay.equipmentSmartSpeaker, 0);

    const planResponse = await call('GET', '/api/v1/dispatch/plan', dispatcherToken);
    const planBody = (await planResponse.json()) as {
      appliedResult: { inputHash: string; routerContextVersion: string } | null;
      plan: {
        routes: Array<{
          legs: Array<{
            travelSource: string;
            trafficFactor: number;
            geometry: { points: Array<{ lat: number; lon: number }> } | null;
          }>;
        }>;
      } | null;
    };
    assert.equal(planBody.appliedResult?.inputHash, inputHash);
    assert.equal(planBody.appliedResult?.routerContextVersion, 'ctx-1');
    assert.equal(planBody.plan?.routes[0]?.legs[0]?.travelSource, 'route_api');
    assert.equal(planBody.plan?.routes[0]?.legs[0]?.trafficFactor, 1.25);
    assert.equal(planBody.plan?.routes[0]?.legs[0]?.geometry?.points.length, 2);

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

  it('applies one ready region while preserving a started pending region exactly', async () => {
    const east = await submitRequest();
    const west = await submitRequest();
    requestIds.push(east.id, west.id);
    await prisma.request.update({ where: { id: east.id }, data: { region: 'partial-east' } });
    await prisma.request.update({ where: { id: west.id }, data: { region: 'partial-west' } });

    const eastProfile = await prisma.engineer.findUniqueOrThrow({ where: { id: engineerId } });
    const eastUpdate = await call(
      'PATCH',
      `/api/v1/dispatch/engineers/${engineerId}`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        expectedVersion: eastProfile.version,
        region: 'partial-east',
      },
    );
    assert.equal(eastUpdate.status, 200, await eastUpdate.clone().text());

    const westEmail = `${unique('partial-west-eng')}@example.test`;
    emails.push(westEmail);
    const westCreated = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email: westEmail,
      displayName: 'Partial West Engineer',
      skills: ['connection'],
      transportType: 'car',
      region: 'partial-west',
      homeLat: 55.72,
      homeLon: 37.58,
    });
    assert.equal(westCreated.status, 201, await westCreated.clone().text());
    const westEngineerId = ((await westCreated.json()) as { engineer: { id: string } }).engineer.id;
    engineerIds.push(westEngineerId);

    const initial = buildRouterResult({
      resultId: unique('regional-base'),
      inputHash: await publishedHash(),
      contextVersion: 'ctx-regional',
      planningAsOf: now(),
      assigned: [
        {
          requestId: east.id,
          engineerId,
          lat: east.lat,
          lon: east.lon,
          startAt: now() + HOUR,
          durationSec: 1200,
        },
        {
          requestId: west.id,
          engineerId: westEngineerId,
          lat: west.lat,
          lon: west.lon,
          startAt: now() + HOUR,
          durationSec: 1200,
        },
      ],
      scheduledLunchFor: [westEngineerId],
      withRoadLeg: true,
    });
    assert.equal((await feed(initial, 'ctx-regional')).body.accepted, true);
    const initialPlan = await prisma.appliedPlanCurrent.findUniqueOrThrow({
      where: { id: 'singleton' },
      include: { plan: { include: { assignments: true } } },
    });
    assert.equal(
      initialPlan.plan.assignments.find((assignment) => assignment.requestId === west.id)?.stopId,
      `${westEngineerId}-stop-0`,
      'initial assignment persists the Router stop id before the regional merge',
    );

    // No republish: this is exactly the live-fact fence that must not make a preserved
    // regional route reject an otherwise fresh east-only increment.
    await prisma.request.update({
      where: { id: west.id },
      data: { startedAt: BigInt(now()), lifecycle: 'in_progress' },
    });
    const partial = structuredClone(
      buildRouterResult({
        resultId: unique('regional-east'),
        inputPublicationId: await publishedPublicationId(),
        inputHash: await publishedHash(),
        contextVersion: 'ctx-regional',
        planningAsOf: now(),
        assigned: [
          {
            requestId: east.id,
            engineerId,
            lat: east.lat,
            lon: east.lon,
            startAt: now() + HOUR + 300,
            durationSec: 1200,
          },
        ],
      }),
    ) as {
      status: string;
      regional_progress: Array<{
        region: string;
        status: 'pending' | 'ready' | 'error';
        request_count: number;
      }>;
    };
    partial.status = 'partial';
    partial.regional_progress = [
      { region: 'partial-east', status: 'ready', request_count: 1 },
      { region: 'partial-west', status: 'pending', request_count: 1 },
      { region: '__default__', status: 'pending', request_count: 0 },
    ];
    const outcome = await feed(partial, 'ctx-regional');
    assert.equal(outcome.body.accepted, true, outcome.body.detail);

    const current = await prisma.appliedPlanCurrent.findUniqueOrThrow({
      where: { id: 'singleton' },
      include: { plan: { include: { routes: { include: { stops: true } }, assignments: true } } },
    });
    const preserved = current.plan.routes.find((route) => route.engineerId === westEngineerId);
    assert.ok(preserved, 'pending west route remains in the new revision');
    assert.equal(preserved.lunchStatus, 'scheduled');
    assert.ok(
      Array.isArray(preserved.legs) && preserved.legs.length > 0,
      'road geometry is retained',
    );
    const lunch = preserved.stops.find((stop) => stop.kind === 'lunch');
    assert.ok(lunch, 'scheduled lunch stop is retained');
    const westAssignment = current.plan.assignments.find(
      (assignment) => assignment.requestId === west.id,
    );
    assert.equal(westAssignment?.status, 'assigned');
    assert.equal(
      westAssignment?.stopId,
      `${westEngineerId}-stop-0`,
      'preserved assignment retains the original Router stop id',
    );
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

    it('restores the immediate predecessor as a new immutable revision', async () => {
      const router = app.get<RouterClient>(RouterClient);
      const getActiveContextVersion = router.getActiveContextVersion.bind(router);
      router.getActiveContextVersion = async () => 'ctx-1';
      const request = await submitRequest();
      const inputHash = await publishedHash();
      const first = await feed(
        buildRouterResult({
          resultId: unique('restore-first'),
          inputHash,
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
      assert.equal(first.body.accepted, true, first.body.detail);
      const policyChange = await call('POST', '/api/v1/dispatch/policy', dispatcherToken, {
        operationId: randomUUID(),
        policyId: 'eco',
      });
      assert.equal(policyChange.status, 201, await policyChange.clone().text());
      const changedInputHash = await publishedHash();
      assert.notEqual(changedInputHash, inputHash);
      const second = await feed(
        buildRouterResult({
          resultId: unique('restore-second'),
          inputHash: changedInputHash,
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + 3 * HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );
      assert.equal(second.body.accepted, true, second.body.detail);

      const before = await call('GET', '/api/v1/dispatch/plan/previous', dispatcherToken);
      assert.equal(before.status, 200, await before.clone().text());
      const pair = (await before.json()) as {
        current: { revision: number };
        previous: { revision: number; routes: Array<{ stops: Array<{ startAt: number }> }> };
        eligibility: { eligible: boolean };
      };
      assert.equal(pair.eligibility.eligible, true);
      assert.equal(pair.previous.revision, first.body.planRevision);

      const restores = await Promise.all([
        call('POST', '/api/v1/dispatch/plan/restore', dispatcherToken, {
          operationId: randomUUID(),
          expectedRevision: pair.current.revision,
        }),
        call('POST', '/api/v1/dispatch/plan/restore', dispatcherToken, {
          operationId: randomUUID(),
          expectedRevision: pair.current.revision,
        }),
      ]);
      const restored = restores.find((response) => response.status === 201);
      const rejected = restores.find((response) => response.status === 409);
      const restoreBodies = (
        await Promise.all(restores.map((response) => response.clone().text()))
      ).join('\n');
      assert.ok(restored, restoreBodies);
      assert.ok(rejected, restoreBodies);
      const body = (await restored.json()) as {
        fromRevision: number;
        restoredRevision: number;
        origin: string;
      };
      assert.equal(body.fromRevision, pair.previous.revision);
      assert.equal(body.origin, 'restore');
      assert.ok(body.restoredRevision > pair.current.revision);

      const after = await call('GET', '/api/v1/dispatch/plan', dispatcherToken);
      const current = (await after.json()) as {
        calculating: boolean;
        plan: {
          revision: number;
          origin: string;
          routes: Array<{ stops: Array<{ startAt: number }> }>;
        };
      };
      assert.equal(current.plan.revision, body.restoredRevision);
      assert.equal(current.plan.origin, 'restore');
      assert.equal(current.calculating, false);
      assert.equal(
        current.plan.routes[0]?.stops[0]?.startAt,
        pair.previous.routes[0]?.stops[0]?.startAt,
      );

      const mcp = app.get(McpToolsService);
      const mcpActor: Actor = {
        kind: 'account',
        source: 'ui',
        id: 'mcp-dispatcher-test',
        role: 'dispatcher',
        tokenCategory: null,
        accountId: 'mcp-dispatcher-test',
      };
      const mcpPrevious = (await mcp.call('get_previous_plan', {}, mcpActor)) as {
        current: { revision: number };
        previous: { revision: number };
        eligibility: { eligible: boolean };
      };
      assert.equal(mcpPrevious.current.revision, body.restoredRevision);
      assert.equal(mcpPrevious.eligibility.eligible, true);

      const mcpOperationId = randomUUID();
      const mcpRestored = await mcp.call(
        'restore_previous_plan',
        { operationId: mcpOperationId, expectedRevision: mcpPrevious.current.revision },
        mcpActor,
      );
      const mcpReplay = await mcp.call(
        'restore_previous_plan',
        { operationId: mcpOperationId, expectedRevision: mcpPrevious.current.revision },
        mcpActor,
      );
      assert.deepEqual(mcpReplay, mcpRestored, 'the supplied MCP operationId must replay');
      await assert.rejects(
        () =>
          mcp.call(
            'restore_previous_plan',
            { operationId: randomUUID(), expectedRevision: mcpPrevious.current.revision },
            mcpActor,
          ),
        (error: unknown) => error instanceof SysError && error.code === 'VERSION_CONFLICT',
      );
      router.getActiveContextVersion = getActiveContextVersion;
    });

    it('refuses restore when a request appeared after both candidate revisions', async () => {
      const router = app.get<RouterClient>(RouterClient);
      const original = router.getActiveContextVersion.bind(router);
      router.getActiveContextVersion = async () => 'ctx-1';
      const request = await submitRequest();
      const inputHash = await publishedHash();
      for (const startAt of [now() + 2 * HOUR, now() + 3 * HOUR]) {
        const applied = await feed(
          buildRouterResult({
            resultId: unique('restore-membership'),
            inputHash,
            contextVersion: 'ctx-1',
            planningAsOf: now(),
            assigned: [
              {
                requestId: request.id,
                engineerId,
                lat: request.lat,
                lon: request.lon,
                startAt,
                durationSec: 1800,
              },
            ],
          }),
          'ctx-1',
        );
        assert.equal(applied.body.accepted, true, applied.body.detail);
      }
      const pair = (await (
        await call('GET', '/api/v1/dispatch/plan/previous', dispatcherToken)
      ).json()) as {
        current: { revision: number };
      };
      await submitRequest();
      const response = await call('POST', '/api/v1/dispatch/plan/restore', dispatcherToken, {
        operationId: randomUUID(),
        expectedRevision: pair.current.revision,
      });
      assert.equal(response.status, 409, await response.clone().text());
      assert.equal(
        ((await response.json()) as { error: { details: { reason: string } } }).error.details
          .reason,
        'INPUT_CONDITIONS_CHANGED',
      );
      router.getActiveContextVersion = original;
    });

    it('refuses restore when a formerly unassigned request has started', async () => {
      const router = app.get<RouterClient>(RouterClient);
      const original = router.getActiveContextVersion.bind(router);
      router.getActiveContextVersion = async () => 'ctx-1';
      const request = await submitRequest();
      const inputHash = await publishedHash();
      const unassigned = await feed(
        buildRouterResult({
          resultId: unique('restore-unassigned'),
          inputHash,
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          unassigned: [{ requestId: request.id, code: 'NO_CAPACITY', text: 'No capacity' }],
        }),
        'ctx-1',
      );
      assert.equal(unassigned.body.accepted, true, unassigned.body.detail);
      const assigned = await feed(
        buildRouterResult({
          resultId: unique('restore-assigned'),
          inputHash,
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          assigned: [
            {
              requestId: request.id,
              engineerId,
              lat: request.lat,
              lon: request.lon,
              startAt: now() + 3 * HOUR,
              durationSec: 1800,
            },
          ],
        }),
        'ctx-1',
      );
      assert.equal(assigned.body.accepted, true, assigned.body.detail);
      const pair = (await (
        await call('GET', '/api/v1/dispatch/plan/previous', dispatcherToken)
      ).json()) as {
        current: { revision: number };
      };
      const started = await call(
        'POST',
        `/api/v1/engineer/requests/${request.id}/facts`,
        engineerToken,
        { operationId: randomUUID(), kind: 'started' },
      );
      assert.equal(started.status, 201, await started.clone().text());
      const response = await call('POST', '/api/v1/dispatch/plan/restore', dispatcherToken, {
        operationId: randomUUID(),
        expectedRevision: pair.current.revision,
      });
      assert.equal(response.status, 409, await response.clone().text());
      assert.equal(
        ((await response.json()) as { error: { details: { reason: string } } }).error.details
          .reason,
        'EXECUTION_FACTS_CHANGED',
      );
      router.getActiveContextVersion = original;
    });

    it('refuses restore when a Router context mutation starts after external preflight', async () => {
      const router = app.get<RouterClient>(RouterClient);
      const original = router.getActiveContextVersion.bind(router);
      const request = await submitRequest();
      const inputHash = await publishedHash();
      router.getActiveContextVersion = async () => 'ctx-1';
      for (const startAt of [now() + 2 * HOUR, now() + 3 * HOUR]) {
        const applied = await feed(
          buildRouterResult({
            resultId: unique('restore-fence'),
            inputHash,
            contextVersion: 'ctx-1',
            planningAsOf: now(),
            assigned: [
              {
                requestId: request.id,
                engineerId,
                lat: request.lat,
                lon: request.lon,
                startAt,
                durationSec: 1800,
              },
            ],
          }),
          'ctx-1',
        );
        assert.equal(applied.body.accepted, true, applied.body.detail);
      }
      const pair = (await (
        await call('GET', '/api/v1/dispatch/plan/previous', dispatcherToken)
      ).json()) as {
        current: { revision: number };
      };
      const operationId = randomUUID();
      router.getActiveContextVersion = async () => {
        await prisma.operation.create({
          data: {
            operationId,
            actorKind: 'system',
            actorId: null,
            source: 'system',
            action: 'router.technical-settings.replace',
            targetRef: 'router-core',
            payloadFingerprint: 'test-context-fence',
            state: 'outcome_unknown',
            createdAt: BigInt(now()),
          },
        });
        return 'ctx-1';
      };
      const response = await call('POST', '/api/v1/dispatch/plan/restore', dispatcherToken, {
        operationId: randomUUID(),
        expectedRevision: pair.current.revision,
      });
      assert.equal(response.status, 409, await response.clone().text());
      assert.equal(
        ((await response.json()) as { error: { details: { reason: string } } }).error.details
          .reason,
        'ROUTER_CONTEXT_MUTATION_PENDING',
      );
      await prisma.operation.delete({ where: { operationId } });
      router.getActiveContextVersion = original;
    });

    it('refuses restore while an equipment handoff remains unconfirmed', async () => {
      const router = app.get<RouterClient>(RouterClient);
      const original = router.getActiveContextVersion.bind(router);
      router.getActiveContextVersion = async () => 'ctx-1';
      const request = await submitRequest();
      const inputHash = await publishedHash();
      for (const startAt of [now() + 2 * HOUR, now() + 3 * HOUR]) {
        const applied = await feed(
          buildRouterResult({
            resultId: unique('restore-handoff'),
            inputHash,
            contextVersion: 'ctx-1',
            planningAsOf: now(),
            assigned: [
              {
                requestId: request.id,
                engineerId,
                lat: request.lat,
                lon: request.lon,
                startAt,
                durationSec: 1800,
              },
            ],
          }),
          'ctx-1',
        );
        assert.equal(applied.body.accepted, true, applied.body.detail);
      }
      const pair = (await (
        await call('GET', '/api/v1/dispatch/plan/previous', dispatcherToken)
      ).json()) as {
        current: { revision: number };
      };
      const handoffId = unique('restore-pending-handoff');
      await prisma.equipmentHandoff.create({
        data: {
          id: handoffId,
          workDate: new Date().toISOString().slice(0, 10),
          donorEngineerId: engineerId,
          receiverEngineerId: engineerId,
          requestId: request.id,
          items: { router: 1 },
          lat: request.lat,
          lon: request.lon,
          meetingAt: BigInt(now() + HOUR),
          createdAt: BigInt(now()),
        },
      });
      const response = await call('POST', '/api/v1/dispatch/plan/restore', dispatcherToken, {
        operationId: randomUUID(),
        expectedRevision: pair.current.revision,
      });
      assert.equal(response.status, 422, await response.clone().text());
      assert.match(await response.text(), /equipment meetings/i);
      await prisma.equipmentHandoff.delete({ where: { id: handoffId } });
      router.getActiveContextVersion = original;
    });

    it('refuses an equipment assignment rollback after the morning issue', async () => {
      const router = app.get<RouterClient>(RouterClient);
      const original = router.getActiveContextVersion.bind(router);
      router.getActiveContextVersion = async () => 'ctx-1';
      const request = await submitRequest('connection_request', 'router');
      const inputHash = await publishedHash();
      const assigned = await feed(
        buildRouterResult({
          resultId: unique('restore-equipment-assigned'),
          inputHash,
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
      assert.equal(assigned.body.accepted, true, assigned.body.detail);
      const unassigned = await feed(
        buildRouterResult({
          resultId: unique('restore-equipment-unassigned'),
          inputHash,
          contextVersion: 'ctx-1',
          planningAsOf: now(),
          unassigned: [{ requestId: request.id, code: 'NO_CAPACITY', text: 'No capacity' }],
        }),
        'ctx-1',
      );
      assert.equal(unassigned.body.accepted, true, unassigned.body.detail);
      const pair = (await (
        await call('GET', '/api/v1/dispatch/plan/previous', dispatcherToken)
      ).json()) as {
        current: { revision: number };
      };
      const response = await call('POST', '/api/v1/dispatch/plan/restore', dispatcherToken, {
        operationId: randomUUID(),
        expectedRevision: pair.current.revision,
      });
      assert.equal(response.status, 409, await response.clone().text());
      assert.equal(
        ((await response.json()) as { error: { details: { reason: string } } }).error.details
          .reason,
        'EQUIPMENT_ISSUED_ASSIGNMENT_CHANGED',
      );
      router.getActiveContextVersion = original;
    });

    it('forwards strict time-window mode to Router technical settings', async () => {
      const router = app.get<RouterClient>(RouterClient);
      const originalConfigured = router.isConfigured.bind(router);
      const originalUpdate = router.updateTechnicalSettings.bind(router);
      const captured: { input?: UpdateRouterTechnicalSettings } = {};
      router.isConfigured = () => true;
      router.updateTechnicalSettings = async (input) => {
        captured.input = input;
        return { ...input, routerContextVersion: 'ctx-strict', status: 'accepted' as const };
      };
      const response = await call(
        'PUT',
        '/api/v1/dispatch/router/technical-settings',
        dispatcherToken,
        {
          operationId: randomUUID(),
          expectedContextVersion: 'ctx-before',
          strictTimeWindows: true,
          lunchesEnabled: false,
          departureLatenessToleranceSec: 0,
          taskStartLatenessToleranceSec: 0,
          windowLatenessToleranceSec: 0,
          trafficEnabled: false,
          metroEnabled: false,
          equipmentTransfersEnabled: false,
          equipmentEnabled: true,
          travelTimeMode: 'graph_with_access_buffer',
          accessBufferSec: 300,
          fixedTravelTimeSec: 600,
          earlyFinishReplanThresholdSec: 900,
          taskOverrunToleranceSec: 600,
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(captured.input?.strictTimeWindows, true);
      router.isConfigured = originalConfigured;
      router.updateTechnicalSettings = originalUpdate;
    });
  });
});
