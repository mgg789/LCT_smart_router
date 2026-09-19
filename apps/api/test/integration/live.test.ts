import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import type { RouterTaskSnapshot } from '../../src/routing/mount-data-eng';
import { createTestClient, databaseUrl, unique } from '../support/database';
import { buildRouterResult } from '../support/router-result';

const HOUR = 3600;

interface LiveEngineerView {
  workday: {
    id: string;
    logicalStartAt: number;
    logicalEndAt: number;
    liveNow: number;
    speedDurationSec: number | null;
  };
  engineer: { lineStatus: string; technicalBreak: { overdueAt: number } | null };
  current: { request: { id: string }; phase: string } | null;
  lunch: { startedAt: number; endAt: number } | null;
  route: { stops: Array<{ kind: string; requestId: string | null; startAt: number }> } | null;
}

/** Regression coverage for the durable LIVE clock and its API boundaries. */
describe('LIVE workday', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;
  let clientToken: string;
  const emails: string[] = [];
  const engineerIds: string[] = [];
  const requestIds: string[] = [];

  const now = () => Math.floor(Date.now() / 1000);
  const workDate = () =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: process.env.APP_TIME_ZONE ?? 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const signIn = async (email: string, role: 'client' | 'engineer') => {
    const issued = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const { devCode } = (await issued.json()) as { devCode: string };
    const verified = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role }),
    });
    assert.equal(verified.status, 201, await verified.clone().text());
    return ((await verified.json()) as { token: string }).token;
  };

  const liveSnapshot = async () => {
    const response = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as {
      publicationId: string;
      inputHash: string;
      planningAsOf: number;
      payload: string;
    };
    return { ...body, snapshot: JSON.parse(body.payload) as RouterTaskSnapshot };
  };

  const liveFeed = async (result: unknown) => {
    const snapshot = await liveSnapshot();
    const packageResult = result as { input_publication_id?: string | null };
    packageResult.input_publication_id = snapshot.publicationId;
    const response = await call('POST', '/api/v1/dispatch/debug/router-result', dispatcherToken, {
      operationId: randomUUID(),
      result,
      activeContextVersion: 'live-test',
    });
    assert.equal(response.status, 201, await response.clone().text());
  };

  const liveCreateEngineer = async (lunch = false) => {
    const email = `${unique('live-eng')}@example.test`;
    emails.push(email);
    const response = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email,
      displayName: 'LIVE Engineer',
      skills: ['connection'],
      transportType: 'car',
      homeLat: 55.75,
      homeLon: 37.62,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const engineer = ((await response.json()) as { engineer: { id: string } }).engineer;
    engineerIds.push(engineer.id);
    const setDay = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineer.id}/workday`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        workDate: workDate(),
        shiftStartAt: now() - HOUR,
        shiftEndAt: now() + 9 * HOUR,
        ...(lunch
          ? {
              lunch: {
                enabled: true,
                durationSec: 2700,
                windowStartAt: now(),
                windowEndAt: now() + 8 * HOUR,
              },
              lunchRequired: true,
            }
          : {}),
      },
    );
    assert.equal(setDay.status, 201, await setDay.clone().text());
    return { ...engineer, token: await signIn(email, 'engineer') };
  };

  const liveCreateRequest = async (offset = 900) => {
    const prepared = await call('POST', '/api/v1/client/requests', clientToken, {
      operationId: randomUUID(),
      contactName: 'LIVE Customer',
      addressText: 'Москва, ул. LIVE, 1',
      lat: 55.78,
      lon: 37.66,
      workType: 'connection_request',
      windowStartAt: now() + offset,
      windowEndAt: now() + offset + 3 * HOUR,
    });
    assert.equal(prepared.status, 201, await prepared.clone().text());
    const request = ((await prepared.json()) as { request: { id: string; version: number } })
      .request;
    requestIds.push(request.id);
    const submitted = await call(
      'POST',
      `/api/v1/client/requests/${request.id}/submit`,
      clientToken,
      { operationId: randomUUID(), expectedVersion: request.version },
    );
    assert.equal(submitted.status, 201, await submitted.clone().text());
    return { ...request, lat: 55.78, lon: 37.66 };
  };

  const liveApplyPlan = async (
    engineerId: string,
    requests: Array<{ id: string; lat: number; lon: number }>,
    lunch = false,
  ) => {
    const snapshot = await liveSnapshot();
    await liveFeed(
      buildRouterResult({
        resultId: unique('live-result'),
        inputHash: snapshot.inputHash,
        contextVersion: 'live-test',
        planningAsOf: snapshot.planningAsOf,
        assigned: requests.map((request, index) => ({
          requestId: request.id,
          engineerId,
          lat: request.lat,
          lon: request.lon,
          startAt: snapshot.planningAsOf + 900 + index * 2400,
          durationSec: 1800,
        })),
        ...(lunch ? { scheduledLunchFor: [engineerId] } : {}),
      }),
    );
  };

  const liveStart = async () => {
    const response = await call('POST', '/api/v1/dispatch/live/start', dispatcherToken, {
      operationId: randomUUID(),
    });
    assert.equal(response.status, 201, await response.clone().text());
  };

  const liveView = async (token: string): Promise<LiveEngineerView> => {
    const response = await call('GET', '/api/v1/engineer/live', token);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as LiveEngineerView;
  };

  const liveAction = (token: string, body: Record<string, unknown>) =>
    call('POST', '/api/v1/engineer/live/actions', token, { operationId: randomUUID(), ...body });

  const liveSetLogicalNow = async (
    workdayId: string,
    logicalStartAt: number,
    logicalEndAt: number,
    logicalTarget: number,
    speedDurationSec: number | null,
  ) => {
    const factor =
      speedDurationSec === null ? 1 : (logicalEndAt - logicalStartAt) / speedDurationSec;
    await prisma.liveWorkday.update({
      where: { id: workdayId },
      data: {
        startedAtWallSec: BigInt(now() - Math.ceil((logicalTarget - logicalStartAt) / factor)),
      },
    });
  };

  before(async () => {
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    // The dedicated LIVE database is durable between local runner invocations. Clear only
    // the mutable planning/live projections so a stopped test cannot donate its running
    // clock or applied route to this test's independently created engineers.
    await prisma.liveWorkday.deleteMany({});
    await prisma.appliedPlanCurrent.deleteMany({});
    await prisma.appliedPlan.deleteMany({});
    await prisma.routerResult.deleteMany({});
    await prisma.alert.deleteMany({ where: { code: 'LIVE_TECHNICAL_BREAK_OVERRUN' } });
    app = await NestFactory.create(AppModule, { logger: false });
    app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/services'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const login = await fetch(`${baseUrl}/api/v1/auth/dispatcher/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      }),
    });
    dispatcherToken = ((await login.json()) as { token: string }).token;
    const email = `${unique('live-client')}@example.test`;
    emails.push(email);
    clientToken = await signIn(email, 'client');
  });

  after(async () => {
    await prisma.appliedPlanCurrent.deleteMany({});
    await prisma.appliedPlan.deleteMany({});
    await prisma.routerResult.deleteMany({});
    await prisma.alert.deleteMany({ where: { code: 'LIVE_TECHNICAL_BREAK_OVERRUN' } });
    await prisma.liveRequestState.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.requestFact.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.requestConditionHistory.deleteMany({ where: { requestId: { in: requestIds } } });
    await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.liveEngineerState.deleteMany({ where: { engineerId: { in: engineerIds } } });
    await prisma.engineerDay.deleteMany({ where: { engineerId: { in: engineerIds } } });
    await prisma.engineer.deleteMany({ where: { id: { in: engineerIds } } });
    await prisma.account.deleteMany({ where: { email: { in: emails } } });
    await app.close();
    await prisma.$disconnect();
  });

  afterEach(async () => {
    // A completed scenario must not leave its accelerated clock running for the next
    // independent scenario in this durable test database.
    await prisma.liveWorkday.deleteMany({});
    await prisma.appliedPlanCurrent.deleteMany({});
    await prisma.appliedPlan.deleteMany({});
    await prisma.routerResult.deleteMany({});
    await prisma.alert.deleteMany({ where: { code: 'LIVE_TECHNICAL_BREAK_OVERRUN' } });
  });

  it('persists a 40-minute delay as a forecast without fabricating completion', async () => {
    const engineer = await liveCreateEngineer();
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request]);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const before = await liveView(engineer.token);
    assert.equal(before.current?.request.id, request.id);
    const job = before.route?.stops.find((stop) => stop.requestId === request.id);
    assert.ok(job);
    await liveSetLogicalNow(
      before.workday.id,
      before.workday.logicalStartAt,
      before.workday.logicalEndAt,
      job.startAt,
      before.workday.speedDurationSec,
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: request.id })).status,
      201,
    );
    const delayed = await liveAction(engineer.token, {
      kind: 'problem',
      requestId: request.id,
      problemKind: 'delay',
      note: 'Need forty minutes more',
      additionalDurationSec: 40 * 60,
    });
    assert.equal(delayed.status, 201, await delayed.clone().text());
    const stored = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(stored.lifecycle, 'in_progress');
    assert.equal(stored.completedAt, null);
    const problem = await prisma.requestFact.findFirstOrThrow({
      where: { requestId: request.id, kind: 'problem' },
    });
    assert.equal(Number(stored.expectedCompletionAt), Number(problem.occurredAt) + 40 * 60);
    const state = await prisma.liveRequestState.findFirstOrThrow({
      where: { requestId: request.id },
    });
    assert.equal(state.additionalDurationSec, 40 * 60);
    assert.equal(state.reservedEngineerId, engineer.id);
  });

  it('requires line entry, blocks legacy fact writes, and accepts a late return after no-show', async () => {
    const engineer = await liveCreateEngineer();
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request]);
    await liveStart();
    const initial = await liveView(engineer.token);
    assert.equal(initial.engineer.lineStatus, 'pending');
    const beforeOnline = await liveAction(engineer.token, { kind: 'start', requestId: request.id });
    assert.equal(beforeOnline.status, 403);
    const legacy = await call(
      'POST',
      `/api/v1/engineer/requests/${request.id}/facts`,
      engineer.token,
      { operationId: randomUUID(), kind: 'started', occurredAt: initial.workday.liveNow },
    );
    assert.equal(legacy.status, 422);
    await liveSetLogicalNow(
      initial.workday.id,
      initial.workday.logicalStartAt,
      initial.workday.logicalEndAt,
      initial.workday.logicalStartAt + 30 * 60 + 1,
      initial.workday.speedDurationSec,
    );
    const noShow = await liveView(engineer.token);
    assert.equal(noShow.engineer.lineStatus, 'no_show_offline');
    const later = await liveAction(engineer.token, { kind: 'online' });
    assert.equal(later.status, 201, await later.clone().text());
    assert.equal((await liveView(engineer.token)).engineer.lineStatus, 'online');
    assert.equal(
      await prisma.liveRequestState.count({
        where: { requestId: request.id, assumedCompletedAt: { not: null } },
      }),
      0,
    );
  });

  it('keeps an ETA reservation after a second accepted plan', async () => {
    const engineer = await liveCreateEngineer();
    const previous = await liveCreateRequest();
    const first = await liveCreateRequest(900);
    const second = await liveCreateRequest(3600);
    await liveApplyPlan(engineer.id, [previous]);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const initial = await liveView(engineer.token);
    const previousStop = initial.route?.stops.find((stop) => stop.requestId === previous.id);
    assert.ok(previousStop);
    assert.equal(
      (await liveAction(engineer.token, { kind: 'on_time', requestId: previous.id })).status,
      201,
    );
    await liveSetLogicalNow(
      initial.workday.id,
      initial.workday.logicalStartAt,
      initial.workday.logicalEndAt,
      previousStop.startAt + 1,
      initial.workday.speedDurationSec,
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: previous.id })).status,
      201,
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'finish', requestId: previous.id })).status,
      201,
    );
    await liveApplyPlan(engineer.id, [first, second]);
    const beforeEta = await liveView(engineer.token);
    assert.equal(beforeEta.current?.request.id, first.id);
    const planned = beforeEta.route?.stops.find((stop) => stop.requestId === first.id);
    assert.ok(planned);
    const etaAt = planned.startAt + 600;
    const eta = await liveAction(engineer.token, { kind: 'eta', requestId: first.id, etaAt });
    assert.equal(eta.status, 201, await eta.clone().text());
    const etaSnapshot = await liveSnapshot();
    await liveFeed(
      buildRouterResult({
        resultId: unique('eta-result'),
        inputHash: etaSnapshot.inputHash,
        contextVersion: 'live-test',
        planningAsOf: etaSnapshot.planningAsOf,
        assigned: [
          {
            requestId: second.id,
            engineerId: engineer.id,
            lat: second.lat,
            lon: second.lon,
            startAt: etaSnapshot.planningAsOf + 4000,
            durationSec: 1800,
          },
        ],
      }),
    );
    const republish = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineer.id}/availability`,
      dispatcherToken,
      { operationId: randomUUID(), availability: 'online' },
    );
    assert.equal(republish.status, 201, await republish.clone().text());
    const next = await liveSnapshot();
    const projected = next.snapshot.engineers.find((item) => item.engineer_id === engineer.id);
    assert.deepEqual(projected?.start_location, { lat: first.lat, lon: first.lon });
    const stored = await prisma.request.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(projected?.available_from, etaAt + stored.serviceDurationSec);
    const after = await liveView(engineer.token);
    assert.equal(after.current?.request.id, first.id);
    assert.equal(after.route?.stops.find((stop) => stop.requestId === first.id)?.startAt, etaAt);
  });

  it('keeps automatic lunch blocking after the plan is rebuilt without a second lunch', async () => {
    const engineer = await liveCreateEngineer(true);
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request], true);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const started = await liveView(engineer.token);
    const lunchStop = started.route?.stops.find((stop) => stop.kind === 'lunch');
    assert.ok(lunchStop, 'the applied plan contains its one automatic lunch');
    const target = lunchStop.startAt + 10;
    await liveSetLogicalNow(
      started.workday.id,
      started.workday.logicalStartAt,
      started.workday.logicalEndAt,
      target,
      started.workday.speedDurationSec,
    );
    const duringLunch = await liveView(engineer.token);
    assert.ok(duringLunch.lunch, 'the scheduled interval is visible');
    const lunchSnapshot = await liveSnapshot();
    await liveFeed(
      buildRouterResult({
        resultId: unique('lunch-result'),
        inputHash: lunchSnapshot.inputHash,
        contextVersion: 'live-test',
        planningAsOf: lunchSnapshot.planningAsOf,
      }),
    );
    const afterReplan = await liveView(engineer.token);
    assert.ok(afterReplan.lunch, 'the persisted interval survives a plan without lunch');
    assert.equal(afterReplan.current, null, 'no work action is available during automatic lunch');
  });

  it('finishes a silent reservation after a replan without creating execution facts', async () => {
    const engineer = await liveCreateEngineer();
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request]);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const before = await liveView(engineer.token);
    const job = before.route?.stops.find((stop) => stop.requestId === request.id);
    assert.ok(job);
    await liveSetLogicalNow(
      before.workday.id,
      before.workday.logicalStartAt,
      before.workday.logicalEndAt,
      job.startAt + 60,
      before.workday.speedDurationSec,
    );
    await liveView(engineer.token);
    const snapshot = await liveSnapshot();
    assert.ok(!snapshot.snapshot.requests.some((item) => item.request_id === request.id));
    await liveFeed(
      buildRouterResult({
        resultId: unique('silent-result'),
        inputHash: snapshot.inputHash,
        contextVersion: 'live-test',
        planningAsOf: snapshot.planningAsOf,
      }),
    );
    const stored = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
    await liveSetLogicalNow(
      before.workday.id,
      before.workday.logicalStartAt,
      before.workday.logicalEndAt,
      job.startAt + stored.serviceDurationSec + 1,
      before.workday.speedDurationSec,
    );
    await liveView(engineer.token);
    assert.ok(
      (await prisma.liveRequestState.findFirstOrThrow({ where: { requestId: request.id } }))
        .assumedCompletedAt,
    );
    assert.equal(
      (await prisma.request.findUniqueOrThrow({ where: { id: request.id } })).lifecycle,
      'submitted',
    );
    assert.equal(await prisma.requestFact.count({ where: { requestId: request.id } }), 0);
  });

  it('keeps explicit overdue work active, accepts more time, and cancels with equipment detail', async () => {
    const engineer = await liveCreateEngineer();
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request]);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const before = await liveView(engineer.token);
    const job = before.route?.stops.find((stop) => stop.requestId === request.id);
    assert.ok(job);
    await liveSetLogicalNow(
      before.workday.id,
      before.workday.logicalStartAt,
      before.workday.logicalEndAt,
      job.startAt + 1,
      before.workday.speedDurationSec,
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: request.id })).status,
      201,
    );
    const started = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
    await liveSetLogicalNow(
      before.workday.id,
      before.workday.logicalStartAt,
      before.workday.logicalEndAt,
      Number(started.expectedCompletionAt) + HOUR,
      before.workday.speedDurationSec,
    );
    await liveView(engineer.token);
    const overdue = await prisma.request.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(overdue.lifecycle, 'in_progress');
    assert.ok(overdue.overrunDetectedAt);
    assert.equal(
      (
        await liveAction(engineer.token, {
          kind: 'problem',
          requestId: request.id,
          problemKind: 'delay',
          note: 'Need more time',
          additionalDurationSec: 2400,
        })
      ).status,
      201,
    );
    assert.equal(
      (await prisma.request.findUniqueOrThrow({ where: { id: request.id } })).overrunDetectedAt,
      null,
    );
    assert.equal(
      (
        await liveAction(engineer.token, {
          kind: 'problem',
          requestId: request.id,
          problemKind: 'missing_equipment',
          note: 'Router missing',
          missingEquipment: 'router',
        })
      ).status,
      201,
    );
    assert.equal(
      (await prisma.request.findUniqueOrThrow({ where: { id: request.id } })).lifecycle,
      'cancelled',
    );
    assert.match(
      (await prisma.liveRequestState.findFirstOrThrow({ where: { requestId: request.id } }))
        .problemNote ?? '',
      /router/i,
    );
  });

  it('raises one overdue technical-break alert and resolves it when the engineer returns', async () => {
    const engineer = await liveCreateEngineer();
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request]);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    assert.equal((await liveAction(engineer.token, { kind: 'break_start' })).status, 201);
    const paused = await liveView(engineer.token);
    assert.ok(paused.engineer.technicalBreak);
    await liveSetLogicalNow(
      paused.workday.id,
      paused.workday.logicalStartAt,
      paused.workday.logicalEndAt,
      paused.engineer.technicalBreak.overdueAt + 1,
      paused.workday.speedDurationSec,
    );
    await liveView(engineer.token);
    await liveView(engineer.token);
    const alert = await prisma.alert.findFirstOrThrow({
      where: { id: { startsWith: `live-break-overdue-${paused.workday.id}-${engineer.id}-` } },
    });
    assert.equal(alert.resolvedAt, null);
    const alertsResponse = await call('GET', '/api/v1/dispatch/alerts', dispatcherToken);
    const alerts = (await alertsResponse.json()) as {
      alerts: Array<{ id: string; reasons: unknown }>;
    };
    assert.ok(
      Array.isArray(alerts.alerts.find((item) => item.id === alert.id)?.reasons),
      'dispatcher alert reasons retain their array contract',
    );
    assert.equal(
      await prisma.alert.count({ where: { id: alert.id } }),
      1,
      'a polling loop must not duplicate the alert',
    );
    assert.equal((await liveAction(engineer.token, { kind: 'break_finish' })).status, 201);
    assert.ok((await prisma.alert.findUniqueOrThrow({ where: { id: alert.id } })).resolvedAt);
  });
});
