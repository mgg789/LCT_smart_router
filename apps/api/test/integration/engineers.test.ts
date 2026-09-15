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
  error: { code: string; details: Record<string, unknown> };
}

interface EngineerBody {
  engineer: { id: string; version: number; skills: string[]; transportType: string };
}

interface DayBody {
  day: {
    engineerId: string;
    workDate: string;
    availability: string;
    expectedOnlineAt: number | null;
    lunch: {
      enabled: boolean;
      durationSec: number | null;
      required: boolean;
      taken: boolean;
      startedAt: number | null;
    };
  };
}

const DAY = 1789459200;
const HOUR = 3600;

/**
 * Acceptance scenarios for engineers and their working days: context/36 section 7,
 * context/37 sections 3.2 and 5, context/42 DF-03, DF-06 and DF-09.
 */
describe('engineers and working days', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;
  const emails: string[] = [];
  const engineerIds: string[] = [];

  const call = async (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const createEngineer = async (overrides: Record<string, unknown> = {}) => {
    const email = `${unique('eng')}@example.test`;
    emails.push(email);
    const response = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email,
      displayName: 'Test Engineer',
      skills: ['connection'],
      transportType: 'car',
      ...overrides,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const engineer = ((await response.json()) as EngineerBody).engineer;
    engineerIds.push(engineer.id);
    return { email, engineer };
  };

  /** Signs the engineer in, which is only possible because the dispatcher created them. */
  const signIn = async (email: string): Promise<string> => {
    const codeResponse = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const { devCode } = (await codeResponse.json()) as { devCode: string };
    const verify = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role: 'engineer' }),
    });
    assert.equal(verify.status, 201, await verify.clone().text());
    return ((await verify.json()) as { token: string }).token;
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
  });

  after(async () => {
    if (engineerIds.length > 0) {
      // Deleting the account does not delete the engineer: a routing profile may exist
      // without a login (context/37 section 3.1), so the relation is SetNull by design and
      // the test has to clean up what it created.
      await prisma.engineerDay.deleteMany({ where: { engineerId: { in: engineerIds } } });
      await prisma.engineer.deleteMany({ where: { id: { in: engineerIds } } });
    }
    if (emails.length > 0) {
      await prisma.account.deleteMany({ where: { email: { in: emails } } });
    }
    await prisma.$disconnect();
    await app?.close();
  });

  it('creates the engineer role only through the dispatcher', async () => {
    const { email, engineer } = await createEngineer();
    assert.ok(engineer.id);

    const account = await prisma.account.findUniqueOrThrow({
      where: { email },
      include: { roles: true },
    });
    assert.deepEqual(
      account.roles.map((role) => role.role).sort(),
      ['engineer'],
      'the dispatcher grants the role; the address alone never does',
    );

    // And only now can that address sign in as an engineer.
    const token = await signIn(email);
    const profile = await call('GET', '/api/v1/engineer/profile', token);
    assert.equal(profile.status, 200);
  });

  it('gives each engineer their own input order', async () => {
    const first = await createEngineer();
    const second = await createEngineer();
    const rows = await prisma.engineer.findMany({
      where: { id: { in: [first.engineer.id, second.engineer.id] } },
      orderBy: { inputOrder: 'asc' },
    });
    assert.equal(rows[0]?.id, first.engineer.id);
    assert.notEqual(rows[0]?.inputOrder, rows[1]?.inputOrder);
  });

  it('refuses more than three skills or a repeated one', async () => {
    const tooMany = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email: `${unique('skills')}@example.test`,
      displayName: 'Too Many Skills',
      skills: ['local', 'connection', 'emergency', 'local'],
      transportType: 'car',
    });
    assert.equal(tooMany.status, 422);

    const duplicated = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email: `${unique('skills')}@example.test`,
      displayName: 'Duplicate Skill',
      skills: ['local', 'local'],
      transportType: 'car',
    });
    assert.equal(duplicated.status, 422);
    assert.equal(((await duplicated.json()) as ErrorBody).error.code, 'VALIDATION_FAILED');
  });

  it('will not enable lunch without a duration and a full window', async () => {
    const { engineer } = await createEngineer();

    const withoutDuration = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineer.id}/workday`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        workDate: '2026-08-17',
        shiftStartAt: DAY + 9 * HOUR,
        shiftEndAt: DAY + 18 * HOUR,
        lunch: { enabled: true },
      },
    );
    // The hours and the length of lunch were never agreed, so a switched-on feature must
    // not run on an invented norm (context/32 section 8).
    assert.equal(withoutDuration.status, 422);

    const windowTooShort = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineer.id}/workday`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        workDate: '2026-08-17',
        shiftStartAt: DAY + 9 * HOUR,
        shiftEndAt: DAY + 18 * HOUR,
        lunch: {
          enabled: true,
          durationSec: 3600,
          windowStartAt: DAY + 12 * HOUR,
          windowEndAt: DAY + 12 * HOUR + 1800,
        },
      },
    );
    assert.equal(windowTooShort.status, 422, 'the whole lunch has to fit inside its window');

    const complete = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineer.id}/workday`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        workDate: '2026-08-17',
        shiftStartAt: DAY + 9 * HOUR,
        shiftEndAt: DAY + 18 * HOUR,
        lunch: {
          enabled: true,
          durationSec: 2700,
          windowStartAt: DAY + 12 * HOUR,
          windowEndAt: DAY + 15 * HOUR,
        },
      },
    );
    assert.equal(complete.status, 201);
    assert.equal(((await complete.json()) as DayBody).day.lunch.enabled, true);
  });

  it('refuses a lunch that is required and disabled at the same time', async () => {
    const { engineer } = await createEngineer();
    const response = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineer.id}/workday`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        workDate: '2026-08-17',
        shiftStartAt: DAY + 9 * HOUR,
        shiftEndAt: DAY + 18 * HOUR,
        lunch: { enabled: false },
        lunchRequired: true,
      },
    );
    // Contradictory conditions are rejected rather than resolved by choosing the
    // convenient half (context/33 section 10.3).
    assert.equal(response.status, 422);
  });

  it('marks the lunch as used only when the engineer actually starts it', async () => {
    const { email } = await createEngineer();
    const token = await signIn(email);

    const before = await call('GET', '/api/v1/engineer/day', token);
    assert.equal(((await before.json()) as DayBody).day.lunch.taken, false);

    const started = await call('POST', '/api/v1/engineer/lunch/start', token, {
      operationId: randomUUID(),
    });
    assert.equal(started.status, 201);
    const afterStart = ((await started.json()) as DayBody).day;
    assert.equal(afterStart.lunch.taken, true);
    assert.ok(afterStart.lunch.startedAt);

    // A second lunch is not available, and finishing the first does not give one back.
    const again = await call('POST', '/api/v1/engineer/lunch/start', token, {
      operationId: randomUUID(),
    });
    assert.equal(again.status, 422);

    const finished = await call('POST', '/api/v1/engineer/lunch/finish', token, {
      operationId: randomUUID(),
    });
    assert.equal(
      ((await finished.json()) as DayBody).day.lunch.taken,
      true,
      'finishing a lunch does not restore the right to a second one',
    );
  });

  it('keeps the used lunch when the feature is switched off and on again', async () => {
    const { email, engineer } = await createEngineer();
    const token = await signIn(email);
    await call('POST', '/api/v1/engineer/lunch/start', token, { operationId: randomUUID() });

    const day = await prisma.engineerDay.findFirstOrThrow({
      where: { engineerId: engineer.id },
    });
    const response = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineer.id}/workday`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        workDate: day.workDate,
        shiftStartAt: DAY + 9 * HOUR,
        shiftEndAt: DAY + 18 * HOUR,
        lunch: { enabled: false },
      },
    );
    assert.equal(response.status, 201);
    // Turning the feature off and on again does not hand back a lunch already used
    // (context/32 section 8).
    assert.equal(((await response.json()) as DayBody).day.lunch.taken, true);
  });

  it('records a technical break as availability with an expected return', async () => {
    const { email } = await createEngineer();
    const token = await signIn(email);

    const response = await call('POST', '/api/v1/engineer/technical-break', token, {
      operationId: randomUUID(),
    });
    assert.equal(response.status, 201);
    const day = ((await response.json()) as DayBody).day;
    assert.equal(day.availability, 'offline');
    // A forecast, not a promise: reaching it creates no online fact.
    assert.ok(day.expectedOnlineAt && day.expectedOnlineAt > 0);
  });

  it('clears the expected return when the engineer comes back online', async () => {
    const { email } = await createEngineer();
    const token = await signIn(email);
    await call('POST', '/api/v1/engineer/technical-break', token, { operationId: randomUUID() });

    const response = await call('POST', '/api/v1/engineer/availability', token, {
      operationId: randomUUID(),
      availability: 'online',
    });
    const day = ((await response.json()) as DayBody).day;
    assert.equal(day.availability, 'online');
    assert.equal(day.expectedOnlineAt, null);
  });

  it('reports a conflict when the engineer and the dispatcher edit the same profile', async () => {
    const { email, engineer } = await createEngineer();
    const token = await signIn(email);

    const byDispatcher = await call(
      'PATCH',
      `/api/v1/dispatch/engineers/${engineer.id}`,
      dispatcherToken,
      { operationId: randomUUID(), expectedVersion: engineer.version, transportType: 'bike' },
    );
    assert.equal(byDispatcher.status, 200);

    const byEngineer = await call('PATCH', '/api/v1/engineer/profile', token, {
      operationId: randomUUID(),
      expectedVersion: engineer.version,
      transportType: 'walk',
    });
    assert.equal(byEngineer.status, 409);
    assert.equal(((await byEngineer.json()) as ErrorBody).error.code, 'VERSION_CONFLICT');

    const stored = await prisma.engineer.findUniqueOrThrow({ where: { id: engineer.id } });
    assert.equal(stored.transportType, 'bike', 'the earlier edit is not silently overwritten');
  });

  it('stores a position report without letting it drive anything', async () => {
    const { email, engineer } = await createEngineer();
    const token = await signIn(email);

    const snapshotsBefore = await prisma.routingSnapshot.count();
    const response = await call('POST', '/api/v1/engineer/gps', token, {
      observedAt: DAY + 10 * HOUR,
      lat: 55.76,
      lon: 37.64,
    });
    assert.equal(response.status, 201);

    const account = await prisma.account.findUniqueOrThrow({ where: { email } });
    const observations = await prisma.gpsObservation.findMany({
      where: { accountId: account.id },
    });
    assert.equal(observations.length, 1);
    // The observation time is kept apart from the arrival time, so a late report is never
    // mistaken for a fresher position (context/37 section 5.2).
    assert.equal(Number(observations[0]?.observedAt), DAY + 10 * HOUR);
    assert.ok(observations[0] && observations[0].recordedAt >= observations[0].observedAt);

    // A point publishes no snapshot and confirms no arrival (context/42 DF-09).
    assert.equal(await prisma.routingSnapshot.count(), snapshotsBefore);
    const day = await prisma.engineerDay.findFirst({ where: { engineerId: engineer.id } });
    assert.equal(day?.lunchTaken ?? false, false);
  });

  it('does not let one engineer act for another', async () => {
    const first = await createEngineer();
    const second = await createEngineer();
    const token = await signIn(first.email);

    const response = await call('PATCH', '/api/v1/engineer/profile', token, {
      operationId: randomUUID(),
      transportType: 'walk',
    });
    assert.equal(response.status, 200);

    // The subject came from the session, so the other engineer is untouched: there is no
    // field in which to name someone else (context/42 DF-06).
    const other = await prisma.engineer.findUniqueOrThrow({ where: { id: second.engineer.id } });
    assert.equal(other.transportType, 'car');
  });
});
