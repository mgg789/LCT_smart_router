import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, mock } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { AppModule } from '../../src/app.module';
import { type Actor } from '../../src/auth';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { OperationsService } from '../../src/operations';
import { EngineersService } from '../../src/orchestrator/engineers';
import { createTestClient, databaseUrl, unique } from '../support/database';

interface ErrorBody {
  error: { code: string; details: Record<string, unknown> };
}

interface EngineerBody {
  engineer: {
    id: string;
    version: number;
    skills: string[];
    transportType: string;
    hasAccount?: boolean;
    email?: string | null;
  };
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
  let engineersService: EngineersService;
  let operations: OperationsService;
  let dispatcherActor: Actor;
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
    const morning = new Date();
    morning.setUTCHours(9, 0, 0, 0);
    mock.timers.enable({ apis: ['Date'], now: morning });
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

    // The link operation is exercised through the system layer it belongs to; the HTTP
    // route for it is covered once it exists.
    engineersService = app.get(EngineersService);
    operations = app.get(OperationsService);
    const dispatcherAccount = await prisma.account.findUniqueOrThrow({
      where: { email: String(process.env.DISPATCHER_EMAIL).toLowerCase() },
    });
    dispatcherActor = {
      kind: 'account',
      source: 'ui',
      id: dispatcherAccount.id,
      role: 'dispatcher',
      tokenCategory: null,
      accountId: dispatcherAccount.id,
    };
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
    mock.timers.reset();
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

  it('lists the linked login address instead of presenting the engineer as unlinked', async () => {
    const { email, engineer } = await createEngineer();
    const response = await call('GET', '/api/v1/dispatch/engineers', dispatcherToken);
    assert.equal(response.status, 200);
    const body = z
      .object({
        engineers: z.array(
          z.object({ id: z.string(), email: z.string().nullable(), hasAccount: z.boolean() }),
        ),
      })
      .parse(await response.json());
    const listed = body.engineers.find((item) => item.id === engineer.id);
    assert.equal(listed?.hasAccount, true);
    assert.equal(listed?.email, email);
  });

  it('creates a routing profile before a login email is known', async () => {
    const { engineer } = await createEngineer({ email: undefined });
    assert.equal(engineer.hasAccount, false);
    assert.equal(engineer.email, null);

    const stored = await prisma.engineer.findUniqueOrThrow({ where: { id: engineer.id } });
    assert.equal(stored.accountId, null);
  });

  it('archives an offline engineer, revokes access and hides the profile from the roster', async () => {
    const { email, engineer } = await createEngineer();
    const token = await signIn(email);

    const response = await call(
      'DELETE',
      `/api/v1/dispatch/engineers/${engineer.id}`,
      dispatcherToken,
      { operationId: randomUUID(), expectedVersion: engineer.version },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const archived = ((await response.json()) as EngineerBody).engineer;
    assert.equal(archived.hasAccount, false);
    assert.equal(archived.email, null);

    const stored = await prisma.engineer.findUniqueOrThrow({ where: { id: engineer.id } });
    assert.notEqual(stored.archivedAt, null);
    assert.equal(stored.accountId, null);

    const listed = await call('GET', '/api/v1/dispatch/engineers', dispatcherToken);
    const body = (await listed.json()) as { engineers: Array<{ id: string }> };
    assert.equal(
      body.engineers.some((item) => item.id === engineer.id),
      false,
    );
    assert.equal((await call('GET', '/api/v1/engineer/profile', token)).status, 401);

    const account = await prisma.account.findUniqueOrThrow({
      where: { email },
      include: { roles: true },
    });
    assert.equal(
      account.roles.some((role) => role.role === 'engineer'),
      false,
    );
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

  it('lets the dispatcher start the same 15-minute technical break', async () => {
    const { engineer } = await createEngineer();
    const before = Math.floor(Date.now() / 1000);
    const response = await call(
      'POST',
      `/api/v1/dispatch/engineers/${engineer.id}/technical-break`,
      dispatcherToken,
      { operationId: randomUUID() },
    );
    assert.equal(response.status, 201, await response.clone().text());
    const day = ((await response.json()) as DayBody).day;
    assert.equal(day.availability, 'offline');
    assert.ok(
      day.expectedOnlineAt !== null &&
        day.expectedOnlineAt >= before + 15 * 60 &&
        day.expectedOnlineAt <= Math.floor(Date.now() / 1000) + 15 * 60,
    );
  });

  it('has no GPS collection endpoint in the engineer API', async () => {
    const { email } = await createEngineer();
    const token = await signIn(email);
    const response = await call('POST', '/api/v1/engineer/gps', token, {
      observedAt: DAY,
      lat: 55.7,
      lon: 37.5,
    });
    assert.equal(response.status, 404);
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

  it('mails one day summary per day when the engineer goes offline, and none on a break', async () => {
    const { email, engineer } = await createEngineer();
    const token = await signIn(email);
    const now = Math.floor(Date.now() / 1000);
    const workDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(now * 1000));
    const keyOf = () => `engineer_day_summary:${engineer.id}:${workDate}`;
    const intents = async () =>
      prisma.notificationIntent.findMany({ where: { businessEventKey: keyOf() } });

    // One started, finished and problem-marked visit today: an hour of confirmed work.
    const request = await prisma.request.create({
      data: {
        arrivalOrder: 9_900_001,
        addressText: 'Москва, ул. Тестовая, д. 3',
        needsGeocoding: false,
        lat: 55.76,
        lon: 37.64,
        normProfileCode: 'base',
        normativeTravelDurationSec: 1800,
        technicalDurationSec: 600,
        documentationDurationSec: 600,
        // The database check requires service time to equal technical plus documentation.
        serviceDurationSec: 1200,
        windowStartAt: BigInt(now - 3 * HOUR),
        windowEndAt: BigInt(now - HOUR),
        requiredSkill: 'connection',
        lifecycle: 'completed',
        origin: 'manual',
        createdAt: BigInt(now - 4 * HOUR),
        updatedAt: BigInt(now - HOUR),
      },
    });
    await prisma.requestFact.createMany({
      data: (
        [
          { kind: 'started', occurredAt: now - 2 * HOUR },
          { kind: 'finished', occurredAt: now - HOUR },
          { kind: 'problem', occurredAt: now - 30 * 60 },
        ] as const
      ).map((fact) => ({
        requestId: request.id,
        engineerId: engineer.id,
        kind: fact.kind,
        occurredAt: BigInt(fact.occurredAt),
        recordedAt: BigInt(fact.occurredAt),
        operationId: randomUUID(),
      })),
    });

    const offline = await call('POST', '/api/v1/engineer/availability', token, {
      operationId: randomUUID(),
      availability: 'offline',
    });
    assert.equal(offline.status, 201, await offline.clone().text());
    const recorded = await intents();
    assert.equal(recorded.length, 1);
    const payload = recorded[0]?.payload as { workMinutes: number; finishedCount: number };
    assert.equal(payload.finishedCount, 1);
    assert.equal(payload.workMinutes, 60);

    // The summary is once per work date, not once per switch: coming back online and
    // leaving again repeats the same business day, not a new letter.
    await call('POST', '/api/v1/engineer/availability', token, {
      operationId: randomUUID(),
      availability: 'online',
    });
    await call('POST', '/api/v1/engineer/availability', token, {
      operationId: randomUUID(),
      availability: 'offline',
    });
    assert.equal((await intents()).length, 1);

    // A technical stop is an offline too, but it is not the end of the day.
    const other = await createEngineer();
    const otherToken = await signIn(other.email);
    await call('POST', '/api/v1/engineer/technical-break', otherToken, {
      operationId: randomUUID(),
    });
    const otherKey = `engineer_day_summary:${other.engineer.id}:${workDate}`;
    assert.equal(
      (await prisma.notificationIntent.findMany({ where: { businessEventKey: otherKey } })).length,
      0,
    );

    await prisma.notificationIntent.deleteMany({
      where: { businessEventKey: { startsWith: 'engineer_day_summary:' } },
    });
    await prisma.requestFact.deleteMany({ where: { requestId: request.id } });
    await prisma.request.delete({ where: { id: request.id } });
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

  /** A routing profile as an import leaves it: no account, no invented parameters. */
  const createCrew = async (skills: ('local' | 'connection' | 'emergency')[] = ['local']) => {
    const crew = await prisma.engineer.create({
      data: {
        displayName: unique('brigade'),
        inputOrder: 1_000_000 + engineerIds.length,
        skills,
        transportType: 'car',
        origin: 'synthesized',
        createdAt: BigInt(DAY),
        updatedAt: BigInt(DAY),
      },
    });
    engineerIds.push(crew.id);
    return crew;
  };

  const link = (engineerId: string, email: string) =>
    operations.execute(
      {
        operationId: randomUUID(),
        actor: dispatcherActor,
        action: 'engineer.link_account',
        targetRef: engineerId,
        payload: { engineerId, email },
      },
      (context) => engineersService.linkAccount(context, engineerId, email),
    );

  it('links a login to a brigade that exists only as a routing profile', async () => {
    const crew = await createCrew();
    const email = `${unique('crew')}@example.test`;
    emails.push(email);

    const outcome = await link(crew.id, email);

    assert.ok(outcome.result.accountId, 'the profile now has a login');
    assert.equal(outcome.result.account?.email, email);
    assert.equal(outcome.result.version, crew.version + 1);
    const roles = await prisma.accountRole.findMany({
      where: { accountId: outcome.result.accountId as string },
    });
    assert.deepEqual(
      roles.map((role) => role.role),
      ['engineer'],
      'the dispatcher granted the role, exactly as when creating an engineer by address',
    );
    // Linking is an access grant, not a profile edit: what Router plans on is untouched.
    assert.deepEqual(outcome.result.skills, ['local']);
  });

  it('refuses a second link and an address another engineer already owns', async () => {
    const { email, engineer } = await createEngineer();
    const crew = await createCrew(['connection']);

    await assert.rejects(
      link(engineer.id, email),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_FAILED',
      'an engineer with a login cannot be linked again',
    );

    await assert.rejects(
      link(crew.id, email),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_FAILED',
      'the address is already the login of another engineer',
    );

    const untouched = await prisma.engineer.findUniqueOrThrow({ where: { id: crew.id } });
    assert.equal(untouched.accountId, null);
    assert.equal(untouched.version, crew.version, 'a refused link leaves no trace');
  });

  it('links a login through the dispatch route and signs the brigade in by code', async () => {
    const crew = await createCrew(['connection']);
    const email = `${unique('crew')}@example.test`;
    emails.push(email);

    const response = await call(
      'POST',
      '/api/v1/dispatch/engineers/link-account',
      dispatcherToken,
      { operationId: randomUUID(), engineerId: crew.id, email },
    );
    assert.equal(response.status, 201, await response.clone().text());
    const view = ((await response.json()) as EngineerBody).engineer;
    assert.equal(view.hasAccount, true);
    assert.equal(view.email, email);

    // The linked brigade signs in through the same public code path as everyone else;
    // the role was granted by the dispatcher at link time (context/36 section 7.2).
    const token = await signIn(email);
    const profile = await call('GET', '/api/v1/engineer/profile', token);
    assert.equal(profile.status, 200);
    const own = ((await profile.json()) as { engineer: EngineerBody['engineer'] }).engineer;
    assert.equal(own.id, crew.id);
    assert.equal(own.email, email);
  });

  it('unlinks a login so the same address can no longer open the Engineer App', async () => {
    const crew = await createCrew(['connection']);
    const email = `${unique('gone')}@example.test`;
    emails.push(email);

    const linked = await call('POST', '/api/v1/dispatch/engineers/link-account', dispatcherToken, {
      operationId: randomUUID(),
      engineerId: crew.id,
      email,
    });
    assert.equal(linked.status, 201, await linked.clone().text());
    const token = await signIn(email);
    const before = await call('GET', '/api/v1/engineer/profile', token);
    assert.equal(before.status, 200);

    const unlinked = await call(
      'POST',
      '/api/v1/dispatch/engineers/unlink-account',
      dispatcherToken,
      { operationId: randomUUID(), engineerId: crew.id },
    );
    assert.equal(unlinked.status, 201, await unlinked.clone().text());
    const view = ((await unlinked.json()) as EngineerBody).engineer;
    assert.equal(view.hasAccount, false);
    assert.equal(view.email, null);

    const stale = await call('GET', '/api/v1/engineer/profile', token);
    assert.equal(stale.status, 401);

    const codeResponse = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const { devCode } = (await codeResponse.json()) as { devCode?: string };
    assert.ok(devCode);
    const verify = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role: 'engineer' }),
    });
    assert.equal(verify.status, 401);
  });

  it('lets the dispatcher replace an engineer login without deleting the profile', async () => {
    const { email, engineer } = await createEngineer();
    const oldToken = await signIn(email);
    const nextEmail = `${unique('changed')}@example.test`;
    emails.push(nextEmail);

    const changed = await call(
      'PUT',
      `/api/v1/dispatch/engineers/${engineer.id}/email`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        expectedVersion: engineer.version,
        email: nextEmail,
      },
    );
    assert.equal(changed.status, 200, await changed.clone().text());
    const view = ((await changed.json()) as EngineerBody).engineer;
    assert.equal(view.id, engineer.id);
    assert.equal(view.email, nextEmail);
    assert.equal(view.version, engineer.version + 1);

    assert.equal((await call('GET', '/api/v1/engineer/profile', oldToken)).status, 401);
    const nextToken = await signIn(nextEmail);
    const profile = await call('GET', '/api/v1/engineer/profile', nextToken);
    assert.equal(profile.status, 200);
    assert.equal(
      ((await profile.json()) as { engineer: EngineerBody['engineer'] }).engineer.id,
      engineer.id,
    );

    const oldAccount = await prisma.account.findUniqueOrThrow({
      where: { email },
      include: { roles: true },
    });
    assert.equal(
      oldAccount.roles.some((role) => role.role === 'engineer'),
      false,
    );

    const staleNoOp = await call(
      'PUT',
      `/api/v1/dispatch/engineers/${engineer.id}/email`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        expectedVersion: engineer.version,
        email: nextEmail,
      },
    );
    assert.equal(staleNoOp.status, 409, await staleNoOp.clone().text());
  });

  it('lets only the dispatcher link logins to engineers', async () => {
    const { email } = await createEngineer();
    const engineerToken = await signIn(email);
    const crew = await createCrew();

    const response = await call('POST', '/api/v1/dispatch/engineers/link-account', engineerToken, {
      operationId: randomUUID(),
      engineerId: crew.id,
      email: `${unique('x')}@example.test`,
    });
    assert.equal(response.status, 403);
    const untouched = await prisma.engineer.findUniqueOrThrow({ where: { id: crew.id } });
    assert.equal(untouched.accountId, null);
  });

  it('issues a 30-day engineer session without extending the dispatcher TTL', async () => {
    const { email } = await createEngineer();
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
    const engineerSession = (await verify.json()) as { expiresAt: number; role: string };
    const now = Math.floor(Date.now() / 1000);
    assert.equal(engineerSession.role, 'engineer');
    assert.ok(
      engineerSession.expiresAt - now >= 29 * 86_400,
      'an engineer session must last a working month on the device',
    );
    assert.ok(engineerSession.expiresAt - now <= 31 * 86_400);

    const dispatcher = await fetch(`${baseUrl}/api/v1/auth/dispatcher/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      }),
    });
    const dispatcherSession = (await dispatcher.json()) as { expiresAt: number };
    assert.ok(
      dispatcherSession.expiresAt - now <= 2 * 86_400,
      'the Dashboard session stays on the ordinary one-day TTL',
    );
  });

  it('returns an empty request list when no working plan is applied', async () => {
    const { email } = await createEngineer();
    const token = await signIn(email);
    const response = await call('GET', '/api/v1/engineer/plan', token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { route: unknown; requests: unknown[] };
    assert.equal(body.route, null);
    assert.deepEqual(body.requests, []);
  });

  it('lets an engineer change their own login after confirming a code', async () => {
    const { email } = await createEngineer();
    const token = await signIn(email);
    const next = `${unique('next')}@example.test`;
    emails.push(next);

    const requested = await call('POST', '/api/v1/engineer/email-change', token, { email: next });
    assert.equal(requested.status, 201, await requested.clone().text());
    const { devCode } = (await requested.json()) as { devCode: string };
    assert.ok(devCode);

    const same = await call('POST', '/api/v1/engineer/email-change', token, { email });
    assert.equal(same.status, 422);

    const confirmed = await call('POST', '/api/v1/engineer/email-change/confirm', token, {
      email: next,
      code: devCode,
    });
    assert.equal(confirmed.status, 201, await confirmed.clone().text());
    const updated = ((await confirmed.json()) as EngineerBody).engineer;
    assert.equal(updated.email, next);

    const profile = await call('GET', '/api/v1/engineer/profile', token);
    assert.equal(((await profile.json()) as EngineerBody).engineer.email, next);

    const oldSignIn = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const oldCode = (await oldSignIn.json()) as { devCode: string };
    const oldVerify = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: oldCode.devCode, role: 'engineer' }),
    });
    assert.equal(oldVerify.status, 401);

    const newToken = await signIn(next);
    const nextProfile = await call('GET', '/api/v1/engineer/profile', newToken);
    assert.equal(nextProfile.status, 200);
  });
});
