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
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl, unique } from '../support/database';
import { buildRouterResult } from '../support/router-result';

interface FactBody {
  request: { id: string };
}

interface AcceptanceBody {
  accepted: boolean;
  reason?: string;
  detail?: string;
}

interface TestRequest {
  id: string;
  lat: number;
  lon: number;
  serviceDurationSec: number;
  submittedAt: number;
}

describe('weather calibration observations', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;
  let clientToken: string;
  let engineerToken: string;
  let engineerId: string;
  let previousPlanId: string | null = null;
  const emails: string[] = [];
  const requestIds: string[] = [];
  const planIds: string[] = [];
  const resultIds: string[] = [];

  const now = (): number => Math.floor(Date.now() / 1000);

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

  const publishedInput = async (): Promise<{ inputHash: string; publicationId: string }> => {
    const response = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    assert.equal(response.status, 200, await response.clone().text());
    const body = (await response.json()) as { inputHash: string; publicationId: string };
    return body;
  };

  const submitRequest = async (suffix: string): Promise<TestRequest> => {
    const response = await call('POST', '/api/v1/client/requests', clientToken, {
      operationId: randomUUID(),
      contactName: `Weather Customer ${suffix}`,
      addressText: `Москва, ул. Погодная, д. ${suffix}`,
      lat: 55.78 + Number(suffix) / 10000,
      lon: 37.66,
      workType: 'connection_request',
      windowStartAt: now() + 60,
      windowEndAt: now() + 4 * 3600,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const created = (await response.json()) as { request: { id: string; version: number } };
    const submitted = await call(
      'POST',
      `/api/v1/client/requests/${created.request.id}/submit`,
      clientToken,
      { operationId: randomUUID(), expectedVersion: created.request.version },
    );
    assert.equal(submitted.status, 201, await submitted.clone().text());
    const row = await prisma.request.findUniqueOrThrow({ where: { id: created.request.id } });
    requestIds.push(row.id);
    return {
      id: row.id,
      lat: row.lat ?? 0,
      lon: row.lon ?? 0,
      serviceDurationSec: row.serviceDurationSec,
      submittedAt: Number(row.submittedAt),
    };
  };

  const feedPlan = async (
    requests: readonly TestRequest[],
    scenario: string,
    withWeatherLeg: boolean,
  ): Promise<{ planId: string; secondStopId: string | null; resultId: string }> => {
    const [firstRequest, secondRequest] = requests;
    assert.ok(firstRequest);
    const { inputHash, publicationId } = await publishedInput();
    const resultId = unique(`weather-${scenario}`);
    resultIds.push(resultId);
    const routeStartAt = firstRequest.submittedAt + 60;
    const planResult = buildRouterResult({
      resultId,
      inputPublicationId: publicationId,
      inputHash,
      contextVersion: 'weather-observations-context',
      planningAsOf: now(),
      assigned: requests.map((request, index) => ({
        requestId: request.id,
        engineerId,
        lat: request.lat,
        lon: request.lon,
        startAt: routeStartAt + (index === 0 ? 0 : firstRequest.serviceDurationSec + 150),
        durationSec: request.serviceDurationSec,
      })),
    }) as {
      main: {
        routes: Array<{ legs: unknown[] }>;
        assignments: Array<{ request_id: string; stop_id: string | null }>;
      };
    };
    planResult.main.assignments.forEach((assignment, index) => {
      assignment.stop_id = `${engineerId}-stop-${index}`;
    });
    const route = planResult.main.routes[0];
    assert.ok(route);
    const secondStopId = secondRequest ? `${engineerId}-stop-1` : null;
    if (withWeatherLeg && secondRequest && secondStopId) {
      const departureAt = firstRequest.submittedAt + 60 + firstRequest.serviceDurationSec;
      route.legs = [
        {
          leg_id: `${scenario}-weather-leg`,
          from_stop_id: `${engineerId}-stop-0`,
          to_stop_id: secondStopId,
          departure_at: departureAt,
          arrival_at: departureAt + 150,
          travel_time_sec: 150,
          distance_km: 3.5,
          geometry: {
            points: [
              { lat: firstRequest.lat, lon: firstRequest.lon },
              { lat: secondRequest.lat, lon: secondRequest.lon },
            ],
          },
          travel_source: 'route_api',
          traffic_factor: 1.25,
          weather_multiplier_used: 1.25,
        },
      ];
    }
    const response = await call('POST', '/api/v1/dispatch/debug/router-result', dispatcherToken, {
      operationId: randomUUID(),
      result: planResult,
      activeContextVersion: 'weather-observations-context',
    });
    const accepted = (await response.json()) as AcceptanceBody;
    assert.equal(response.status, 201, JSON.stringify(accepted));
    assert.equal(accepted.accepted, true, accepted.detail);
    const current = await prisma.appliedPlanCurrent.findUniqueOrThrow({
      where: { id: 'singleton' },
    });
    planIds.push(current.planId);
    return { planId: current.planId, secondStopId, resultId };
  };

  const recordFact = async (
    requestId: string,
    kind: 'arrived' | 'started' | 'finished',
    occurredAt: number,
  ) => {
    const response = await call(
      'POST',
      `/api/v1/engineer/requests/${requestId}/facts`,
      engineerToken,
      { operationId: randomUUID(), kind, occurredAt },
    );
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()) as FactBody;
  };

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_DEV_EXPOSE_CODES = 'true';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    previousPlanId =
      (await prisma.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } }))?.planId ?? null;

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
    assert.equal(dispatcher.status, 201, await dispatcher.clone().text());
    dispatcherToken = ((await dispatcher.json()) as { token: string }).token;

    const clientEmail = `${unique('weather-client')}@example.test`;
    emails.push(clientEmail);
    clientToken = await signIn(clientEmail, 'client');
    const engineerEmail = `${unique('weather-eng')}@example.test`;
    emails.push(engineerEmail);
    const created = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email: engineerEmail,
      displayName: 'Weather Observation Engineer',
      skills: ['connection', 'emergency'],
      transportType: 'car',
      homeLat: 55.75,
      homeLon: 37.62,
    });
    assert.equal(created.status, 201, await created.clone().text());
    engineerId = ((await created.json()) as { engineer: { id: string } }).engineer.id;
    await prisma.engineer.update({ where: { id: engineerId }, data: { region: 'weather-test' } });
    const workday = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineerId}/workday`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        workDate: new Intl.DateTimeFormat('en-CA', {
          timeZone: process.env.APP_TIME_ZONE ?? 'Europe/Moscow',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()),
        shiftStartAt: now() - 3600,
        shiftEndAt: now() + 10 * 3600,
      },
    );
    assert.equal(workday.status, 201, await workday.clone().text());
    engineerToken = await signIn(engineerEmail, 'engineer');
  });

  after(async () => {
    if (planIds.length > 0) {
      await prisma.appliedPlanCurrent.deleteMany({ where: { planId: { in: planIds } } });
      await prisma.appliedPlan.deleteMany({ where: { id: { in: planIds } } });
    }
    if (previousPlanId) {
      await prisma.appliedPlanCurrent.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', planId: previousPlanId, updatedAt: BigInt(now()) },
        update: { planId: previousPlanId, updatedAt: BigInt(now()) },
      });
    }
    if (resultIds.length > 0) {
      await prisma.routerResult.deleteMany({ where: { resultId: { in: resultIds } } });
    }
    if (requestIds.length > 0) {
      await prisma.requestFact.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.requestConditionHistory.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.notificationIntent.deleteMany({
        where: {
          OR: requestIds.map((requestId) => ({ businessEventKey: { contains: requestId } })),
        },
      });
      await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
    }
    if (engineerId) {
      await prisma.engineerDay.deleteMany({ where: { engineerId } });
      await prisma.engineer.deleteMany({ where: { id: engineerId } });
    }
    if (emails.length > 0) await prisma.account.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
    await prisma?.$disconnect();
  });

  it('captures the next leg baseline on arrival and finish', async () => {
    const first = await submitRequest('1');
    const second = await submitRequest('2');
    const plan = await feedPlan([first, second], 'valid', true);
    const startAt = first.submittedAt + 60;
    const finishAt = startAt + first.serviceDurationSec;

    await recordFact(first.id, 'arrived', startAt);
    const arrival = await prisma.requestFact.findFirstOrThrow({
      where: { requestId: first.id, kind: 'arrived' },
    });
    const arrivalMetadata = arrival.metadata as {
      weatherCalibration: { planId: string; workDate: string };
    };
    assert.equal(arrivalMetadata.weatherCalibration.planId, plan.planId);
    assert.ok(arrivalMetadata.weatherCalibration.workDate);

    await recordFact(first.id, 'started', startAt);
    await recordFact(first.id, 'finished', finishAt);
    const finished = await prisma.requestFact.findFirstOrThrow({
      where: { requestId: first.id, kind: 'finished' },
    });
    const metadata = finished.metadata as {
      weatherCalibration: {
        planId: string;
        nextRequestId?: string;
        region?: string;
        transport?: string;
        departureAt?: number;
        weatherMultiplierUsed?: number;
        canonicalSec?: number;
      };
    };
    assert.deepEqual(metadata.weatherCalibration, {
      planId: plan.planId,
      workDate: arrivalMetadata.weatherCalibration.workDate,
      nextRequestId: second.id,
      region: 'weather-test',
      transport: 'car',
      departureAt: finishAt,
      weatherMultiplierUsed: 1.25,
      canonicalSec: 120,
    });
  });

  it('keeps common metadata but refuses to pair a changed next-stop leg', async () => {
    const first = await submitRequest('3');
    const second = await submitRequest('4');
    const plan = await feedPlan([first, second], 'changed-route', true);
    const currentRoute = await prisma.appliedPlanRoute.findUniqueOrThrow({
      where: { planId_engineerId: { planId: plan.planId, engineerId } },
    });
    const originalLegs = currentRoute.legs as Array<Record<string, unknown>>;
    await prisma.appliedPlanRoute.update({
      where: { id: currentRoute.id },
      data: {
        legs: originalLegs.map((leg) => ({
          ...leg,
          toStopId: 'different-next-stop',
        })) as Prisma.InputJsonValue,
      },
    });

    const startAt = first.submittedAt + 60;
    await recordFact(first.id, 'started', startAt);
    await recordFact(first.id, 'finished', startAt + first.serviceDurationSec);
    const finished = await prisma.requestFact.findFirstOrThrow({
      where: { requestId: first.id, kind: 'finished' },
    });
    const metadata = finished.metadata as { weatherCalibration: Record<string, unknown> };
    assert.deepEqual(metadata.weatherCalibration, {
      planId: plan.planId,
      workDate: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date((startAt + first.serviceDurationSec) * 1000)),
    });
  });

  it('retains the common plan metadata when the finished request was the last stop', async () => {
    const last = await submitRequest('5');
    const plan = await feedPlan([last], 'last-stop', false);
    const startAt = last.submittedAt + 60;
    const finishAt = startAt + last.serviceDurationSec;

    await recordFact(last.id, 'started', startAt);
    await recordFact(last.id, 'finished', finishAt);
    const finished = await prisma.requestFact.findFirstOrThrow({
      where: { requestId: last.id, kind: 'finished' },
    });
    const metadata = finished.metadata as { weatherCalibration: Record<string, unknown> };
    assert.deepEqual(metadata.weatherCalibration, {
      planId: plan.planId,
      workDate: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(finishAt * 1000)),
    });
  });
});
