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
import { LiveService } from '../../src/orchestrator/live/live.service';
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
  engineer: {
    lineStatus: string;
    technicalBreak: { overdueAt: number } | null;
    progress: {
      phase: string;
      origin: { lat: number; lon: number };
      anchor: { requestId: string | null };
      lunch: { kind: string; lat: number; lon: number } | null;
      next: { requestId: string | null } | null;
    } | null;
    routeState: 'active' | 'awaiting_plan' | 'exhausted';
  };
  current: { request: { id: string }; phase: string } | null;
  lunch: { startedAt: number; endAt: number } | null;
  route: {
    stops: Array<{
      kind: string;
      requestId: string | null;
      startAt: number;
      endAt: number;
      lat: number;
      lon: number;
    }>;
  } | null;
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
    await prisma.alert.deleteMany({
      where: { code: { in: ['LIVE_TECHNICAL_BREAK_OVERRUN', 'LIVE_WINDOW_COMPLETION_RISK'] } },
    });
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
    await prisma.alert.deleteMany({
      where: { code: { in: ['LIVE_TECHNICAL_BREAK_OVERRUN', 'LIVE_WINDOW_COMPLETION_RISK'] } },
    });
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
    await prisma.alert.deleteMany({
      where: { code: { in: ['LIVE_TECHNICAL_BREAK_OVERRUN', 'LIVE_WINDOW_COMPLETION_RISK'] } },
    });
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
    const remaining = await liveSnapshot();
    await liveFeed(
      buildRouterResult({
        resultId: unique('active-detail'),
        inputHash: remaining.inputHash,
        contextVersion: 'live-test',
        planningAsOf: remaining.planningAsOf,
      }),
    );
    const detail = await call('GET', `/api/v1/engineer/requests/${request.id}`, engineer.token);
    assert.equal(detail.status, 200, await detail.clone().text());
    assert.ok(
      (await liveView(engineer.token)).route?.stops.some((stop) => stop.requestId === request.id),
    );
  });

  it('requires line entry, blocks legacy fact writes, and accepts a late return after no-show', async () => {
    const engineer = await liveCreateEngineer();
    await liveCreateEngineer();
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
    const publicationCountBefore = await prisma.routingSnapshot.count();
    const noShow = await liveView(engineer.token);
    const publicationCountAfter = await prisma.routingSnapshot.count();
    assert.equal(noShow.engineer.lineStatus, 'no_show_offline');
    assert.equal(
      publicationCountAfter - publicationCountBefore,
      1,
      'one no-show boundary must publish one snapshot for the whole engineer batch',
    );
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

  it('releases an ETA that cannot finish inside the completion grace and raises one alert', async () => {
    const engineer = await liveCreateEngineer();
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request]);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const view = await liveView(engineer.token);
    const stop = view.route?.stops.find((item) => item.requestId === request.id);
    assert.ok(stop);
    const etaAt = stop.startAt + 600;
    await prisma.request.update({
      where: { id: request.id },
      data: { windowEndAt: BigInt(etaAt + 1800 - 601) },
    });
    const response = await liveAction(engineer.token, {
      kind: 'eta',
      requestId: request.id,
      etaAt,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const state = await prisma.liveRequestState.findFirstOrThrow({
      where: { requestId: request.id },
    });
    assert.equal(state.reservedEngineerId, null);
    assert.equal(state.reportedEtaAt, null);
    assert.equal(state.replanPendingEngineerId, engineer.id);
    assert.ok(state.replanRequestedAt);
    assert.ok(
      await prisma.alert.findUnique({
        where: { id: `live-window-infeasible-${view.workday.id}-${request.id}` },
      }),
    );
    assert.ok(
      (await liveSnapshot()).snapshot.requests.some((item) => item.request_id === request.id),
    );
    const waiting = await liveView(engineer.token);
    assert.equal(waiting.current, null);
    assert.equal(waiting.engineer.routeState, 'awaiting_plan');
    assert.equal(
      waiting.engineer.progress?.next ?? null,
      null,
      'the stale route must not draw an edge to the released request while replanning',
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: request.id })).status,
      403,
      'the rejected stop stays non-interactive until a newer plan is accepted',
    );
    await liveApplyPlan(engineer.id, [request]);
    assert.equal(
      (await liveView(engineer.token)).current?.request.id,
      request.id,
      'a newer accepted revision releases the revision-scoped waiting state',
    );
  });

  it('allows an early start after the customer window opens and keeps durable route timestamps', async () => {
    const engineer = await liveCreateEngineer();
    const request = await liveCreateRequest();
    const nextRequest = await liveCreateRequest(3600);
    const lastRequest = await liveCreateRequest(7200);
    await liveApplyPlan(engineer.id, [request, nextRequest, lastRequest]);
    await liveStart();
    const before = await liveView(engineer.token);
    const stop = before.route?.stops.find((item) => item.requestId === request.id);
    assert.ok(stop);
    await prisma.request.update({
      where: { id: request.id },
      data: { windowStartAt: BigInt(before.workday.logicalStartAt) },
    });
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const ready = await liveView(engineer.token);
    assert.equal(ready.current?.phase, 'ready_to_start');
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: request.id })).status,
      201,
    );
    const anchored = await prisma.liveEngineerState.findFirstOrThrow({
      where: { workdayId: ready.workday.id, engineerId: engineer.id },
    });
    assert.equal(anchored.routeAnchorRequestId, request.id);
    assert.ok(anchored.routeAnchorReachedAt);
    assert.equal(
      (await liveAction(engineer.token, { kind: 'finish', requestId: request.id })).status,
      201,
    );
    const departed = await prisma.liveEngineerState.findFirstOrThrow({
      where: { workdayId: ready.workday.id, engineerId: engineer.id },
    });
    assert.equal(departed.routeAnchorRequestId, request.id);
    assert.ok(departed.routeAnchorDepartedAt);
    const afterFirst = await liveView(engineer.token);
    assert.equal(
      afterFirst.current?.request.id,
      nextRequest.id,
      'a terminal stop in the accepted plan must not hide its next submitted stop',
    );
    const nextStop = afterFirst.route?.stops.find((item) => item.requestId === nextRequest.id);
    assert.ok(nextStop);
    await liveSetLogicalNow(
      afterFirst.workday.id,
      afterFirst.workday.logicalStartAt,
      afterFirst.workday.logicalEndAt,
      nextStop.startAt,
      afterFirst.workday.speedDurationSec,
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: nextRequest.id })).status,
      201,
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'finish', requestId: nextRequest.id })).status,
      201,
    );
    const afterSecond = await liveView(engineer.token);
    assert.equal(afterSecond.current?.request.id, lastRequest.id);
    assert.equal(
      afterSecond.engineer.progress?.next?.requestId,
      lastRequest.id,
      'the factual cursor must not point back to the already completed first stop',
    );
    const dispatch = await call('GET', '/api/v1/dispatch/live', dispatcherToken);
    const body = (await dispatch.json()) as {
      history: Array<{ request: { id: string }; terminalAt: number }>;
    };
    assert.ok(body.history.some((item) => item.request.id === request.id && item.terminalAt > 0));
  });

  it('keeps the captured day origin when a remaining-day revision replaces the route', async () => {
    const engineer = await liveCreateEngineer();
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request]);
    await liveStart();
    const initial = await liveView(engineer.token);
    const before = initial.engineer.progress?.origin;
    assert.ok(before, 'a started day exposes its stable depot vertex before line entry');
    const state = await prisma.liveEngineerState.findFirstOrThrow({
      where: { workdayId: initial.workday.id, engineerId: engineer.id },
    });
    assert.equal(state.routeOriginLat, before.lat);
    assert.equal(state.routeOriginLon, before.lon);
    assert.ok(state.routeOriginAt);
    // The live route start will normally change to the factual anchor on replan. This
    // sentinel makes the no-overwrite rule explicit without inventing a second route API.
    await prisma.liveEngineerState.update({
      where: { id: state.id },
      data: { routeOriginLat: 55.701, routeOriginLon: 37.501 },
    });
    await liveApplyPlan(engineer.id, [request]);
    const after = (await liveView(engineer.token)).engineer.progress?.origin;
    assert.deepEqual(after && { lat: after.lat, lon: after.lon }, { lat: 55.701, lon: 37.501 });
  });

  it('exposes a planned lunch as one compound edge immediately after the preceding finish', async () => {
    const engineer = await liveCreateEngineer(true);
    const first = await liveCreateRequest();
    const second = await liveCreateRequest(15_000);
    const snapshot = await liveSnapshot();
    await liveFeed(
      buildRouterResult({
        resultId: unique('lunch-between-jobs'),
        inputHash: snapshot.inputHash,
        contextVersion: 'live-test',
        planningAsOf: snapshot.planningAsOf,
        assigned: [
          {
            requestId: first.id,
            engineerId: engineer.id,
            lat: first.lat,
            lon: first.lon,
            startAt: snapshot.planningAsOf + 900,
            durationSec: 900,
          },
          {
            requestId: second.id,
            engineerId: engineer.id,
            lat: second.lat,
            lon: second.lon,
            startAt: snapshot.planningAsOf + 15_000,
            durationSec: 900,
          },
        ],
        scheduledLunchFor: [engineer.id],
        lunchAfterAssignedIndex: 0,
      }),
    );
    await liveStart();
    const started = await liveView(engineer.token);
    await prisma.request.update({
      where: { id: first.id },
      data: { windowStartAt: BigInt(started.workday.logicalStartAt) },
    });
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: first.id })).status,
      201,
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'finish', requestId: first.id })).status,
      201,
    );
    assert.equal(
      (await prisma.request.findUniqueOrThrow({ where: { id: first.id } })).lifecycle,
      'completed',
    );
    const afterFinish = await liveView(engineer.token);
    assert.equal(afterFinish.engineer.progress?.phase, 'traveling', JSON.stringify(afterFinish));
    assert.equal(afterFinish.engineer.progress?.anchor.requestId, first.id);
    assert.equal(afterFinish.engineer.progress?.lunch?.kind, 'lunch');
    assert.equal(afterFinish.engineer.progress?.next?.requestId, second.id);
    const remaining = await liveSnapshot();
    await liveFeed(
      buildRouterResult({
        resultId: unique('lunch-after-anchor-replan'),
        inputHash: remaining.inputHash,
        contextVersion: 'live-test',
        planningAsOf: remaining.planningAsOf,
        assigned: [
          {
            requestId: second.id,
            engineerId: engineer.id,
            lat: second.lat,
            lon: second.lon,
            startAt: remaining.planningAsOf + 3600,
            durationSec: 900,
          },
        ],
        scheduledLunchFor: [engineer.id],
        lunchAfterAssignedIndex: -1,
      }),
    );
    const afterReplan = await liveView(engineer.token);
    assert.equal(afterReplan.engineer.progress?.anchor.requestId, first.id);
    assert.equal(afterReplan.engineer.progress?.lunch?.kind, 'lunch');
    assert.equal(afterReplan.engineer.progress?.next?.requestId, second.id);
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
    assert.equal(afterReplan.engineer.progress?.phase, 'lunch');
    assert.ok(
      afterReplan.engineer.progress?.lunch,
      'the persisted lunch coordinates keep the highlighted traversal after replan',
    );
    assert.equal(afterReplan.current, null, 'no work action is available during automatic lunch');
  });

  it('projects an active lunch as the Router start point until its durable end time', async () => {
    const engineer = await liveCreateEngineer(true);
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request], true);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const started = await liveView(engineer.token);
    const lunchStop = started.route?.stops.find((stop) => stop.kind === 'lunch');
    assert.ok(lunchStop);
    await prisma.engineerDay.update({
      where: { engineerId_workDate: { engineerId: engineer.id, workDate: workDate() } },
      data: { lunchDurationSec: 1800 },
    });
    await liveSetLogicalNow(
      started.workday.id,
      started.workday.logicalStartAt,
      started.workday.logicalEndAt,
      lunchStop.startAt + 10,
      started.workday.speedDurationSec,
    );
    const duringLunch = await liveView(engineer.token);
    assert.equal(duringLunch.engineer.progress?.phase, 'lunch');
    assert.ok(duringLunch.engineer.progress?.lunch);
    const snapshot = await liveSnapshot();
    const projected = snapshot.snapshot.engineers.find((item) => item.engineer_id === engineer.id);
    assert.deepEqual(projected?.start_location, { lat: lunchStop.lat, lon: lunchStop.lon });
    assert.equal(
      projected?.available_from,
      Number(
        (
          await prisma.liveEngineerState.findFirstOrThrow({
            where: { workdayId: started.workday.id, engineerId: engineer.id },
          })
        ).activeLunchStartedAt,
      ) + 1800,
    );
  });

  it('holds the first post-lunch visit for five logical minutes and clears lunch on explicit start', async () => {
    const engineer = await liveCreateEngineer(true);
    const first = await liveCreateRequest();
    const second = await liveCreateRequest(4200);
    const snapshot = await liveSnapshot();
    await liveFeed(
      buildRouterResult({
        resultId: unique('post-lunch-handoff'),
        inputHash: snapshot.inputHash,
        contextVersion: 'live-test',
        planningAsOf: snapshot.planningAsOf,
        assigned: [
          {
            requestId: first.id,
            engineerId: engineer.id,
            lat: first.lat,
            lon: first.lon,
            startAt: snapshot.planningAsOf + 900,
            durationSec: 900,
          },
          {
            requestId: second.id,
            engineerId: engineer.id,
            lat: second.lat,
            lon: second.lon,
            startAt: snapshot.planningAsOf + 4200,
            durationSec: 900,
          },
        ],
        scheduledLunchFor: [engineer.id],
        lunchAfterAssignedIndex: 0,
      }),
    );
    await liveStart();
    const started = await liveView(engineer.token);
    const lunchStop = started.route?.stops.find((stop) => stop.kind === 'lunch');
    assert.ok(lunchStop);
    await prisma.engineerDay.update({
      where: { engineerId_workDate: { engineerId: engineer.id, workDate: workDate() } },
      data: { lunchDurationSec: 1800 },
    });
    await prisma.request.update({
      where: { id: first.id },
      data: { windowStartAt: BigInt(started.workday.logicalStartAt) },
    });
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: first.id })).status,
      201,
    );
    assert.equal(
      (await liveAction(engineer.token, { kind: 'finish', requestId: first.id })).status,
      201,
    );
    await liveSetLogicalNow(
      started.workday.id,
      started.workday.logicalStartAt,
      started.workday.logicalEndAt,
      lunchStop.startAt + 1,
      started.workday.speedDurationSec,
    );
    await liveView(engineer.token);
    const actualLunchEndAt = lunchStop.startAt + 1 + 1800;
    await liveSetLogicalNow(
      started.workday.id,
      started.workday.logicalStartAt,
      started.workday.logicalEndAt,
      actualLunchEndAt,
      started.workday.speedDurationSec,
    );
    const atEnd = await liveView(engineer.token);
    assert.equal(atEnd.current?.request.id, second.id, JSON.stringify(atEnd));
    assert.equal(atEnd.current?.phase, 'ready_to_start');
    assert.equal(atEnd.engineer.progress?.lunch?.kind, 'lunch');
    assert.equal(
      (await prisma.liveRequestState.findFirst({ where: { requestId: second.id } }))
        ?.assumedStartedAt ?? null,
      null,
    );
    const atEndSnapshot = await liveSnapshot();
    assert.deepEqual(
      atEndSnapshot.snapshot.engineers.find((item) => item.engineer_id === engineer.id)
        ?.start_location,
      { lat: lunchStop.lat, lon: lunchStop.lon },
    );
    await liveSetLogicalNow(
      started.workday.id,
      started.workday.logicalStartAt,
      started.workday.logicalEndAt,
      actualLunchEndAt + 299,
      started.workday.speedDurationSec,
    );
    const beforeGraceEnd = await liveView(engineer.token);
    assert.equal(beforeGraceEnd.current?.request.id, second.id);
    assert.equal(beforeGraceEnd.engineer.progress?.lunch?.kind, 'lunch');
    assert.equal(
      (await liveAction(engineer.token, { kind: 'start', requestId: second.id })).status,
      201,
    );
    const state = await prisma.liveEngineerState.findFirstOrThrow({
      where: { workdayId: started.workday.id, engineerId: engineer.id },
    });
    assert.equal(state.activeLunchLat, null);
    assert.equal(state.activeLunchLon, null);
    assert.equal(state.activeLunchStartedAt, null);
  });

  it('does not enter a stale planned lunch after the dispatcher disables it', async () => {
    const engineer = await liveCreateEngineer(true);
    const request = await liveCreateRequest();
    await liveApplyPlan(engineer.id, [request], true);
    await liveStart();
    assert.equal((await liveAction(engineer.token, { kind: 'online' })).status, 201);
    const started = await liveView(engineer.token);
    const lunchStop = started.route?.stops.find((stop) => stop.kind === 'lunch');
    assert.ok(lunchStop, 'the accepted plan contains the lunch that will become stale');
    await app.get(LiveService).synchronizeGlobalLunchSwitch(false);
    await liveSetLogicalNow(
      started.workday.id,
      started.workday.logicalStartAt,
      started.workday.logicalEndAt,
      lunchStop.startAt + 10,
      started.workday.speedDurationSec,
    );
    const afterDisable = await liveView(engineer.token);
    assert.equal(afterDisable.lunch, null);
    const day = await prisma.engineerDay.findUniqueOrThrow({
      where: { engineerId_workDate: { engineerId: engineer.id, workDate: workDate() } },
    });
    assert.equal(day.lunchEnabled, false);
    assert.equal(day.lunchTaken, false);
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
    const cancelledAnchor = await prisma.liveEngineerState.findFirstOrThrow({
      where: { workdayId: before.workday.id, engineerId: engineer.id },
    });
    assert.ok(cancelledAnchor.routeAnchorDepartedAt);
    const afterCancel = await liveSnapshot();
    const projected = afterCancel.snapshot.engineers.find(
      (item) => item.engineer_id === engineer.id,
    );
    assert.deepEqual(projected?.start_location, { lat: request.lat, lon: request.lon });
    assert.equal(projected?.available_from, Number(cancelledAnchor.routeAnchorDepartedAt));
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
    const dispatch = await call('GET', '/api/v1/dispatch/live', dispatcherToken);
    const view = (await dispatch.json()) as {
      breaks: Array<{ engineerId: string; endedAt: number | null }>;
    };
    assert.ok(
      view.breaks.some((stop) => stop.engineerId === engineer.id && stop.endedAt !== null),
      'finished technical stops remain in dispatcher history',
    );
  });

  it('finishes the day when no submitted request can still be served', async () => {
    const engineer = await liveCreateEngineer();
    const submitted = await prisma.request.findMany({
      where: { lifecycle: 'submitted' },
      select: {
        id: true,
        lifecycle: true,
        assignmentState: true,
        completedAt: true,
        updatedAt: true,
        version: true,
      },
    });
    await prisma.engineerDay.updateMany({
      where: { engineerId: { in: engineerIds }, workDate: workDate() },
      data: {
        lunchTaken: false,
        lunchStartedAt: null,
        lunchEnabled: false,
        lunchDurationSec: null,
        lunchWindowStartAt: null,
        lunchWindowEndAt: null,
        lunchRequired: false,
        updatedAt: BigInt(now()),
        version: { increment: 1 },
      },
    });
    await prisma.request.updateMany({
      where: { id: { in: submitted.map((request) => request.id) } },
      data: {
        lifecycle: 'completed',
        assignmentState: 'assigned',
        completedAt: BigInt(now()),
        updatedAt: BigInt(now()),
        version: { increment: 1 },
      },
    });
    try {
      await liveStart();

      const response = await call('GET', '/api/v1/engineer/live', engineer.token);
      assert.equal(response.status, 200, await response.clone().text());
      const view = (await response.json()) as {
        workday: {
          status: string;
          completionReason: string | null;
          finishedAt: number | null;
          liveNow: number;
        };
      };
      assert.equal(view.workday.status, 'finished');
      assert.equal(view.workday.completionReason, 'schedule_exhausted');
      assert.ok(view.workday.finishedAt);
      assert.equal(view.workday.liveNow, view.workday.finishedAt);
    } finally {
      await Promise.all(
        submitted.map((request) =>
          prisma.request.update({
            where: { id: request.id },
            data: {
              lifecycle: request.lifecycle,
              assignmentState: request.assignmentState,
              completedAt: request.completedAt,
              updatedAt: request.updatedAt,
              version: request.version,
            },
          }),
        ),
      );
    }
  });
});
