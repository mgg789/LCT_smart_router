import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, mock } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl, unique } from '../support/database';

const HOUR = 3600;
const STALE_AFTER_SEC = 45 * 24 * HOUR;

interface ErrorBody {
  error?: { code?: string; details?: Record<string, unknown> };
}

interface PassportBody {
  passport: {
    address: string;
    connectionType: string;
    difficulty: number;
    updatedAt: number;
    stale: boolean;
  } | null;
  canFill: boolean;
  unavailableReason?: string;
  pointsAwarded?: number;
  monthlyPoints?: number;
}

interface EngineerBody {
  engineer: { id: string; version: number };
}

/**
 * Exercises object-passport ownership, freshness, idempotency and monthly rewards
 * through the real Nest HTTP boundary and a dedicated PostgreSQL database.
 */
describe('object passports', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;
  let engineerAToken: string;
  let engineerBToken: string;
  let engineerAId = '';
  let engineerBId = '';
  let currentAId = '';
  let futureAId = '';
  let currentBId = '';
  let planId = '';
  let workdayId = '';
  const emails: string[] = [];
  const operationIds: string[] = [];
  const now = () => Math.floor(Date.now() / 1000);

  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const bodyOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  const signInEngineer = async (email: string): Promise<string> => {
    const issued = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(issued.status, 201, await issued.clone().text());
    const { devCode } = await bodyOf<{ devCode: string }>(issued);
    const verified = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role: 'engineer' }),
    });
    assert.equal(verified.status, 201, await verified.clone().text());
    return (await bodyOf<{ token: string }>(verified)).token;
  };

  const createEngineer = async (name: string) => {
    const email = `${unique(name.toLowerCase().replaceAll(' ', '-'))}@example.test`;
    emails.push(email);
    const response = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email,
      displayName: name,
      skills: ['connection'],
      transportType: 'car',
      homeLat: 55.75,
      homeLon: 37.62,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const engineer = (await bodyOf<EngineerBody>(response)).engineer;
    return { ...engineer, email, token: await signInEngineer(email) };
  };

  const passportInput = (operationId = randomUUID()) => {
    operationIds.push(operationId);
    return {
      operationId,
      connectionType: 'fiber',
      difficulty: 2,
      equipment: 'OTDR',
      accessNotes: 'Key at security desk',
      comment: 'Integration passport',
    };
  };

  const responseError = async (response: Response) => bodyOf<ErrorBody>(response);

  const markStarted = async (requestId: string, engineerId: string) => {
    const startedAt = now();
    await prisma.request.update({
      where: { id: requestId },
      data: { lifecycle: 'in_progress', startedAt: BigInt(startedAt) },
    });
    await prisma.requestFact.create({
      data: {
        requestId,
        engineerId,
        kind: 'started',
        occurredAt: BigInt(startedAt),
        recordedAt: BigInt(startedAt),
        operationId: randomUUID(),
      },
    });
  };

  before(async () => {
    assert.ok(
      process.env.TEST_DATABASE_URL,
      'Use an isolated TEST_DATABASE_URL for passport tests',
    );
    process.env.LOCATION_IQ_TOKEN = 'passport-test-provider-token';
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();

    await prisma.engineerPassportPoint.deleteMany({});
    await prisma.objectPassport.deleteMany({});
    await prisma.reverseGeocodeCache.deleteMany({});
    await prisma.liveRequestState.deleteMany({});
    await prisma.liveEngineerState.deleteMany({});
    await prisma.liveWorkday.deleteMany({});
    await prisma.appliedPlanCurrent.deleteMany({});
    await prisma.appliedPlanAssignment.deleteMany({});
    await prisma.appliedPlanStop.deleteMany({});
    await prisma.appliedPlanRoute.deleteMany({});
    await prisma.appliedPlan.deleteMany({});
    await prisma.request.deleteMany({});
    await prisma.engineerDay.deleteMany({});
    await prisma.engineer.deleteMany({});
    await prisma.building.deleteMany({});

    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
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
    dispatcherToken = (await bodyOf<{ token: string }>(dispatcher)).token;

    const engineerA = await createEngineer('Passport engineer A');
    const engineerB = await createEngineer('Passport engineer B');
    engineerAId = engineerA.id;
    engineerBId = engineerB.id;
    engineerAToken = engineerA.token;
    engineerBToken = engineerB.token;

    const clock = now();
    const workDate = '2099-01-01';
    const generationRow = await prisma.appState.findUnique({ where: { key: 'generation' } });
    const generation = typeof generationRow?.value === 'number' ? generationRow.value : 1;
    await prisma.engineerDay.createMany({
      data: [engineerAId, engineerBId].map((engineerId) => ({
        engineerId,
        workDate,
        shiftStartAt: BigInt(clock - HOUR),
        shiftEndAt: BigInt(clock + 10 * HOUR),
        createdAt: BigInt(clock),
        updatedAt: BigInt(clock),
      })),
    });

    const coordinateKey = '55.750000,37.620000';
    await prisma.reverseGeocodeCache.create({
      data: {
        coordinateKey,
        canonicalAddress: 'москва, тестовая улица, 10',
        provider: 'integration-fixture',
        resolvedAt: BigInt(clock),
      },
    });
    const requestData = (arrivalOrder: number) => ({
      arrivalOrder,
      addressText: 'Москва, тестовая улица, д. 10',
      lat: 55.75,
      lon: 37.62,
      needsGeocoding: false,
      normProfileCode: 'connection',
      normativeTravelDurationSec: 600,
      technicalDurationSec: 1800,
      documentationDurationSec: 300,
      serviceDurationSec: 2100,
      windowStartAt: BigInt(clock - 600),
      windowEndAt: BigInt(clock + 4 * HOUR),
      requiredSkill: 'connection' as const,
      lifecycle: 'submitted' as const,
      assignmentState: 'assigned' as const,
      origin: 'manual' as const,
      createdAt: BigInt(clock),
      submittedAt: BigInt(clock),
      updatedAt: BigInt(clock),
    });
    const [currentA, futureA, currentB] = await Promise.all([
      prisma.request.create({ data: requestData(1) }),
      prisma.request.create({ data: requestData(2) }),
      prisma.request.create({ data: requestData(3) }),
    ]);
    currentAId = currentA.id;
    futureAId = futureA.id;
    currentBId = currentB.id;

    const plan = await prisma.appliedPlan.create({
      data: {
        origin: 'auto',
        planAsOf: BigInt(clock),
        appliedAt: BigInt(clock),
        routes: {
          create: [
            {
              engineerId: engineerAId,
              startLat: 55.75,
              startLon: 37.62,
              startAt: BigInt(clock - 300),
              finishAt: BigInt(clock + 4 * HOUR),
              assignedCount: 2,
              workTimeSec: 4200,
              lunchStatus: 'disabled',
              legs: [],
              reasons: [],
              stops: {
                create: [
                  {
                    sequence: 0,
                    kind: 'job',
                    requestId: currentAId,
                    lat: 55.75,
                    lon: 37.62,
                    arrivalAt: BigInt(clock - 60),
                    startAt: BigInt(clock - 60),
                    endAt: BigInt(clock + HOUR),
                  },
                  {
                    sequence: 1,
                    kind: 'job',
                    requestId: futureAId,
                    lat: 55.75,
                    lon: 37.62,
                    arrivalAt: BigInt(clock + 2 * HOUR),
                    startAt: BigInt(clock + 2 * HOUR),
                    endAt: BigInt(clock + 3 * HOUR),
                  },
                ],
              },
            },
            {
              engineerId: engineerBId,
              startLat: 55.75,
              startLon: 37.62,
              startAt: BigInt(clock - 300),
              finishAt: BigInt(clock + 4 * HOUR),
              assignedCount: 1,
              workTimeSec: 2100,
              lunchStatus: 'disabled',
              legs: [],
              reasons: [],
              stops: {
                create: [
                  {
                    sequence: 0,
                    kind: 'job',
                    requestId: currentBId,
                    lat: 55.75,
                    lon: 37.62,
                    arrivalAt: BigInt(clock - 60),
                    startAt: BigInt(clock - 60),
                    endAt: BigInt(clock + HOUR),
                  },
                ],
              },
            },
          ],
        },
        assignments: {
          create: [
            { requestId: currentAId, status: 'assigned', engineerId: engineerAId, reasons: [] },
            { requestId: futureAId, status: 'assigned', engineerId: engineerAId, reasons: [] },
            { requestId: currentBId, status: 'assigned', engineerId: engineerBId, reasons: [] },
          ],
        },
      },
      include: { routes: true },
    });
    planId = plan.id;
    await prisma.appliedPlanCurrent.create({
      data: { planId, updatedAt: BigInt(clock) },
    });

    const workday = await prisma.liveWorkday.create({
      data: {
        generation,
        workDate,
        status: 'running',
        logicalStartAt: BigInt(clock),
        logicalEndAt: BigInt(clock + 10 * HOUR),
        startedAtWallSec: BigInt(clock),
        createdAt: BigInt(clock),
        updatedAt: BigInt(clock),
        engineers: {
          create: [
            {
              engineerId: engineerAId,
              lineStatus: 'online',
              lineStartedAt: BigInt(clock),
              createdAt: BigInt(clock),
              updatedAt: BigInt(clock),
            },
            {
              engineerId: engineerBId,
              lineStatus: 'online',
              lineStartedAt: BigInt(clock),
              createdAt: BigInt(clock),
              updatedAt: BigInt(clock),
            },
          ],
        },
      },
    });
    workdayId = workday.id;
  });

  after(async () => {
    await prisma.engineerPassportPoint.deleteMany({});
    await prisma.objectPassport.deleteMany({});
    await prisma.reverseGeocodeCache.deleteMany({});
    await prisma.liveRequestState.deleteMany({ where: { workdayId } });
    await prisma.liveEngineerState.deleteMany({ where: { workdayId } });
    await prisma.liveWorkday.deleteMany({ where: { id: workdayId } });
    await prisma.appliedPlanCurrent.deleteMany({ where: { planId } });
    await prisma.appliedPlanAssignment.deleteMany({ where: { planId } });
    await prisma.appliedPlanStop.deleteMany({ where: { route: { planId } } });
    await prisma.appliedPlanRoute.deleteMany({ where: { planId } });
    await prisma.appliedPlan.deleteMany({ where: { id: planId } });
    await prisma.request.deleteMany({ where: { id: { in: [currentAId, futureAId, currentBId] } } });
    await prisma.engineerDay.deleteMany({
      where: { engineerId: { in: [engineerAId, engineerBId] } },
    });
    await prisma.engineer.deleteMany({ where: { id: { in: [engineerAId, engineerBId] } } });
    await prisma.account.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
    await prisma.$disconnect();
  });

  it('enforces current ownership, idempotency, freshness and Moscow-month points', async () => {
    const current = await call(
      'GET',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerAToken,
    );
    assert.equal(current.status, 200, await current.clone().text());
    const currentBody = await bodyOf<PassportBody>(current);
    assert.equal(currentBody.passport, null);
    assert.equal(currentBody.canFill, false);
    assert.equal(currentBody.unavailableReason, 'WORK_NOT_STARTED');

    const deniedBeforeStart = await call(
      'POST',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerAToken,
      passportInput(),
    );
    assert.equal(deniedBeforeStart.status, 403);

    await Promise.all([markStarted(currentAId, engineerAId), markStarted(currentBId, engineerBId)]);
    const started = await call(
      'GET',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerAToken,
    );
    assert.equal(started.status, 200, await started.clone().text());
    assert.equal((await bodyOf<PassportBody>(started)).canFill, true);

    const future = await call(
      'GET',
      `/api/v1/engineer/requests/${futureAId}/passport`,
      engineerAToken,
    );
    assert.equal(future.status, 200, await future.clone().text());
    assert.equal((await bodyOf<PassportBody>(future)).unavailableReason, 'REQUEST_NOT_CURRENT');

    const nonOwner = await call(
      'GET',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerBToken,
    );
    assert.equal(nonOwner.status, 404, await nonOwner.clone().text());

    const deniedFuture = await call(
      'POST',
      `/api/v1/engineer/requests/${futureAId}/passport`,
      engineerAToken,
      passportInput(),
    );
    assert.equal(deniedFuture.status, 403);
    const unauthenticated = await call(
      'GET',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      'invalid-test-token',
    );
    assert.equal(unauthenticated.status, 401);

    const firstInput = passportInput();
    const firstSave = await call(
      'POST',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerAToken,
      firstInput,
    );
    assert.equal(firstSave.status, 201, await firstSave.clone().text());
    const firstBody = await bodyOf<PassportBody>(firstSave);
    assert.equal(firstBody.pointsAwarded, 35);
    assert.equal(firstBody.monthlyPoints, 35);

    const pointsAfterFirst = await call('GET', '/api/v1/engineer/points', engineerAToken);
    assert.equal(pointsAfterFirst.status, 200, await pointsAfterFirst.clone().text());
    assert.equal((await bodyOf<{ monthlyPoints: number }>(pointsAfterFirst)).monthlyPoints, 35);

    const replay = await call(
      'POST',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerAToken,
      firstInput,
    );
    assert.equal(replay.status, 201, await replay.clone().text());
    assert.equal((await bodyOf<PassportBody>(replay)).monthlyPoints, 35);
    assert.equal(await prisma.engineerPassportPoint.count(), 1);

    const freshReject = await call(
      'POST',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerAToken,
      passportInput(),
    );
    assert.equal(freshReject.status, 409, await freshReject.clone().text());
    assert.equal((await responseError(freshReject)).error?.code, 'VERSION_CONFLICT');
    assert.equal(await prisma.engineerPassportPoint.count(), 1);

    await prisma.objectPassport.updateMany({
      data: { updatedAt: BigInt(now() - STALE_AFTER_SEC - 1) },
    });
    const concurrent = await Promise.all([
      call(
        'POST',
        `/api/v1/engineer/requests/${currentAId}/passport`,
        engineerAToken,
        passportInput(),
      ),
      call(
        'POST',
        `/api/v1/engineer/requests/${currentBId}/passport`,
        engineerBToken,
        passportInput(),
      ),
    ]);
    const concurrentStatuses = concurrent.map((response) => response.status).sort((a, b) => a - b);
    assert.deepEqual(concurrentStatuses, [201, 409]);
    assert.equal(await prisma.engineerPassportPoint.count(), 2);

    const pointsAfterRace = await call(
      'GET',
      `/api/v1/dispatch/engineers/${engineerAId}/points`,
      dispatcherToken,
    );
    assert.equal(pointsAfterRace.status, 200, await pointsAfterRace.clone().text());
    const totalAfterRace = (await bodyOf<{ monthlyPoints: number }>(pointsAfterRace)).monthlyPoints;
    assert.ok(totalAfterRace === 35 || totalAfterRace === 70);
    const combinedTotal = await prisma.engineerPassportPoint.aggregate({ _sum: { points: true } });
    assert.equal(combinedTotal._sum.points, 70);

    const staleAt = now() - STALE_AFTER_SEC - 1;
    await prisma.objectPassport.updateMany({ data: { updatedAt: BigInt(staleAt) } });
    const staleSave = await call(
      'POST',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerAToken,
      passportInput(),
    );
    assert.equal(staleSave.status, 201, await staleSave.clone().text());
    assert.equal((await bodyOf<PassportBody>(staleSave)).monthlyPoints, totalAfterRace + 35);

    await prisma.engineerPassportPoint.create({
      data: {
        engineerId: engineerAId,
        operationId: randomUUID(),
        points: 500,
        awardedAt: BigInt(now() - 40 * 24 * HOUR),
      },
    });
    const pointsAfterOldEntry = await call('GET', '/api/v1/engineer/points', engineerAToken);
    assert.equal(pointsAfterOldEntry.status, 200, await pointsAfterOldEntry.clone().text());
    assert.equal(
      (await bodyOf<{ monthlyPoints: number }>(pointsAfterOldEntry)).monthlyPoints,
      totalAfterRace + 35,
    );

    // A replay must remain owned even if another authenticated engineer knows the id.
    const stolenReplay = await call(
      'POST',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerBToken,
      firstInput,
    );
    assert.equal(stolenReplay.status, 409);
    assert.equal((await responseError(stolenReplay)).error?.code, 'OPERATION_ID_REUSED');

    const futureWithPassport = await call(
      'GET',
      `/api/v1/engineer/requests/${futureAId}/passport`,
      engineerAToken,
    );
    assert.equal((await bodyOf<PassportBody>(futureWithPassport)).passport?.difficulty, 2);

    // Identical simultaneous retries must both succeed and add only one ledger entry.
    await prisma.objectPassport.updateMany({ data: { updatedAt: BigInt(staleAt) } });
    const sameInput = passportInput();
    const sameRace = await Promise.all(
      [0, 1].map(() =>
        call('POST', `/api/v1/engineer/requests/${currentAId}/passport`, engineerAToken, sameInput),
      ),
    );
    assert.deepEqual(
      sameRace.map((response) => response.status),
      [201, 201],
    );
    assert.equal(
      await prisma.engineerPassportPoint.count({ where: { operationId: sameInput.operationId } }),
      1,
    );

    // A lost success response remains replayable after leaving the original visit.
    await prisma.request.update({
      where: { id: currentAId },
      data: { lifecycle: 'completed', completedAt: BigInt(now()) },
    });
    const movedReplay = await call(
      'POST',
      `/api/v1/engineer/requests/${currentAId}/passport`,
      engineerAToken,
      sameInput,
    );
    assert.equal(movedReplay.status, 201);
    assert.equal(
      await prisma.engineerPassportPoint.count({ where: { operationId: sameInput.operationId } }),
      1,
    );

    const dispatcherRead = await call(
      'GET',
      `/api/v1/dispatch/requests/${currentAId}/passport`,
      dispatcherToken,
    );
    assert.equal(dispatcherRead.status, 200, await dispatcherRead.clone().text());
    assert.equal((await bodyOf<PassportBody>(dispatcherRead)).passport?.difficulty, 2);
  });

  it('resolves map coordinates once and shares the explicit building passport', async () => {
    const nativeFetch = globalThis.fetch;
    let providerCalls = 0;
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname !== 'eu1.locationiq.com') return nativeFetch(input, init);
        providerCalls += 1;
        assert.equal(url.pathname, '/v1/reverse');
        assert.equal(url.searchParams.get('accept-language'), 'ru');
        return Response.json({
          address: { city: 'Москва', road: 'Тестовая улица', house_number: '10' },
        });
      },
    );
    try {
      await prisma.request.update({
        where: { id: futureAId },
        data: { addressText: 'Точка на карте', lat: 55.751, lon: 37.621 },
      });
      for (const token of [engineerAToken, engineerAToken]) {
        const response = await call(
          'GET',
          `/api/v1/engineer/requests/${futureAId}/passport`,
          token,
        );
        assert.equal(response.status, 200);
        const body = await bodyOf<PassportBody>(response);
        assert.equal(body.passport?.address, 'москва, тестовая улица, 10');
        assert.equal(body.passport?.difficulty, 2);
        assert.equal(body.canFill, false);
      }
      assert.equal(providerCalls, 1);
      assert.equal(
        await prisma.reverseGeocodeCache.count({
          where: { coordinateKey: '55.751000,37.621000', provider: 'locationiq' },
        }),
        1,
      );
    } finally {
      fetchMock.mock.restore();
    }
  });
});
