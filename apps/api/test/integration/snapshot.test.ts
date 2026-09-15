import '../support/env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors';
import { canonicalHash } from '../../src/common/json';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl, unique } from '../support/database';

interface SnapshotDebug {
  published: boolean;
  inputHash?: string;
  planningAsOf?: number;
  trigger?: string;
  diagnostics?: {
    requestsIncluded: number;
    engineersIncluded: number;
    requestsWithoutLocation: number;
    requestsOutsideHorizon: number;
    engineersWithoutStartLocation: number;
  };
  payload?: string;
}

const HOUR = 3600;

/**
 * Acceptance scenarios for `mount-data-eng`.
 *
 * The publication matrix of context/42 section 3 is the specification these assert: which
 * events publish a new task and, just as importantly, which must not.
 */
describe('snapshot publication', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let dispatcherToken: string;
  let clientToken: string;
  let clientEmail: string;
  const emails: string[] = [];
  const requestIds: string[] = [];
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

  const snapshot = async (): Promise<SnapshotDebug> => {
    const response = await call('GET', '/api/v1/dispatch/debug/snapshot', dispatcherToken);
    assert.equal(response.status, 200);
    return (await response.json()) as SnapshotDebug;
  };

  const signInClient = async (email: string): Promise<string> => {
    const codeResponse = await fetch(`${baseUrl}/api/v1/auth/login-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const { devCode } = (await codeResponse.json()) as { devCode: string };
    const verify = await fetch(`${baseUrl}/api/v1/auth/login-code/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: devCode, role: 'client' }),
    });
    return ((await verify.json()) as { token: string }).token;
  };

  /** A day that is always "today" for the service, so shifts land in the live horizon. */
  const today = (offsetHours: number): number => {
    const now = Math.floor(Date.now() / 1000);
    return now + offsetHours * HOUR;
  };

  const createEngineer = async (overrides: Record<string, unknown> = {}, withShift = true) => {
    const email = `${unique('snap-eng')}@example.test`;
    emails.push(email);
    const response = await call('POST', '/api/v1/dispatch/engineers', dispatcherToken, {
      operationId: randomUUID(),
      email,
      displayName: 'Snapshot Engineer',
      skills: ['connection', 'emergency'],
      transportType: 'car',
      homeLat: 55.75,
      homeLon: 37.62,
      ...overrides,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const engineer = ((await response.json()) as { engineer: { id: string; version: number } })
      .engineer;
    engineerIds.push(engineer.id);

    if (withShift) {
      // An engineer with no shift cannot be planned for, so the dispatcher sets one --
      // exactly as in the real flow.
      const day = await call(
        'POST',
        `/api/v1/dispatch/engineers/${engineer.id}/workday`,
        dispatcherToken,
        {
          operationId: randomUUID(),
          workDate: new Intl.DateTimeFormat('en-CA', {
            timeZone: process.env.APP_TIME_ZONE ?? 'Europe/Moscow',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date()),
          shiftStartAt: today(-1),
          shiftEndAt: today(9),
        },
      );
      assert.equal(day.status, 201, await day.clone().text());
    }
    return engineer;
  };

  const createRequest = async (overrides: Record<string, unknown> = {}) => {
    const prepared = await call('POST', '/api/v1/client/requests', clientToken, {
      operationId: randomUUID(),
      contactName: 'Snapshot Customer',
      addressText: 'Москва, ул. Тестовая, д. 3',
      lat: 55.78,
      lon: 37.66,
      workType: 'connection_request',
      windowStartAt: today(1),
      windowEndAt: today(3),
      ...overrides,
    });
    assert.equal(prepared.status, 201, await prepared.clone().text());
    const request = ((await prepared.json()) as { request: { id: string; version: number } })
      .request;
    requestIds.push(request.id);
    return request;
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

    clientEmail = `${unique('snap-client')}@example.test`;
    emails.push(clientEmail);
    clientToken = await signInClient(clientEmail);
  });

  after(async () => {
    if (requestIds.length > 0) {
      await prisma.requestConditionHistory.deleteMany({ where: { requestId: { in: requestIds } } });
      await prisma.notificationIntent.deleteMany({
        where: { businessEventKey: { in: requestIds.map((id) => `request_received:${id}`) } },
      });
      await prisma.request.deleteMany({ where: { id: { in: requestIds } } });
    }
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

  it('publishes a new task when a request is confirmed', async () => {
    const before = await snapshot();
    const request = await createRequest();

    // A draft is not a task: preparing it must not have published anything.
    const afterPrepare = await snapshot();
    assert.equal(afterPrepare.inputHash, before.inputHash);

    await call('POST', `/api/v1/client/requests/${request.id}/submit`, clientToken, {
      operationId: randomUUID(),
      expectedVersion: request.version,
    });

    const afterSubmit = await snapshot();
    assert.equal(afterSubmit.published, true);
    assert.notEqual(afterSubmit.inputHash, before.inputHash);
    assert.equal(afterSubmit.trigger, 'request.submitted');
  });

  it('stores the exact bytes that were hashed', async () => {
    const current = await snapshot();
    assert.ok(current.payload);
    const document = JSON.parse(current.payload);
    // Parsing and re-serializing the stored text must land on the same digest, which is
    // what makes an independently computed hash on Router's side meaningful.
    assert.equal(canonicalHash(document), current.inputHash);
  });

  it('does not republish when a change leaves the task identical', async () => {
    const engineer = await createEngineer();
    const before = await snapshot();

    // The display name is not part of the planning task, so the projection is unchanged.
    const response = await call(
      'PATCH',
      `/api/v1/dispatch/engineers/${engineer.id}`,
      dispatcherToken,
      { operationId: randomUUID(), expectedVersion: engineer.version, displayName: 'Renamed' },
    );
    assert.equal(response.status, 200);

    const after = await snapshot();
    assert.equal(after.inputHash, before.inputHash);
    // And the moment of the published task did not move, which is the point: rewriting
    // the same content must not produce an endless series of timestamps
    // (context/33 section 7).
    assert.equal(after.planningAsOf, before.planningAsOf);
  });

  it('does not move planning_as_of when a trigger fires a second later with no change', async () => {
    const engineer = await createEngineer();
    const before = await snapshot();

    // The clock has to cross a second boundary: the bug this guards against was a
    // projection that embedded the publication moment, so an unchanged task produced a new
    // hash every second and planning_as_of effectively ticked -- which context/33 section 7
    // forbids.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const response = await call(
      'PATCH',
      `/api/v1/dispatch/engineers/${engineer.id}`,
      dispatcherToken,
      {
        operationId: randomUUID(),
        expectedVersion: engineer.version,
        displayName: 'Renamed Again',
      },
    );
    assert.equal(response.status, 200);

    const after = await snapshot();
    assert.equal(after.inputHash, before.inputHash, 'the task did not change');
    assert.equal(after.planningAsOf, before.planningAsOf, 'so its moment must not move');
  });

  it('publishes when the engineer starts lunch, so no second one can be planned', async () => {
    const engineer = await createEngineer();
    const account = await prisma.engineer.findUniqueOrThrow({ where: { id: engineer.id } });
    const email = (
      await prisma.account.findUniqueOrThrow({ where: { id: account.accountId ?? '' } })
    ).email;

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
    const engineerToken = ((await verify.json()) as { token: string }).token;

    const before = await snapshot();
    await call('POST', '/api/v1/engineer/lunch/start', engineerToken, {
      operationId: randomUUID(),
    });
    const after = await snapshot();

    assert.notEqual(after.inputHash, before.inputHash);
    assert.equal(after.trigger, 'engineer.lunch_taken');

    const document = JSON.parse(after.payload ?? '{}') as {
      engineers: Array<{ engineer_id: string; lunch_taken: boolean; lunch: { required: boolean } }>;
    };
    const projected = document.engineers.find((item) => item.engineer_id === engineer.id);
    assert.ok(projected);
    assert.equal(projected.lunch_taken, true);
    // A fact outranks a leftover requirement (context/33 section 10.3).
    assert.equal(projected.lunch.required, false);
  });

  it('does not publish for a position report', async () => {
    const engineer = await createEngineer();
    const record = await prisma.engineer.findUniqueOrThrow({ where: { id: engineer.id } });
    const email = (
      await prisma.account.findUniqueOrThrow({ where: { id: record.accountId ?? '' } })
    ).email;
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
    const engineerToken = ((await verify.json()) as { token: string }).token;

    const before = await snapshot();
    const snapshotCountBefore = await prisma.routingSnapshot.count();

    await call('POST', '/api/v1/engineer/gps', engineerToken, {
      observedAt: Math.floor(Date.now() / 1000),
      lat: 55.7,
      lon: 37.5,
    });
    // Reading the day and the plan are not triggers either.
    await call('GET', '/api/v1/engineer/day', engineerToken);
    await call('GET', '/api/v1/dispatch/requests', dispatcherToken);

    const after = await snapshot();
    assert.equal(after.inputHash, before.inputHash);
    assert.equal(await prisma.routingSnapshot.count(), snapshotCountBefore);
  });

  it('excludes a request without coordinates and counts it in the diagnostics', async () => {
    const before = await snapshot();
    const request = await createRequest({ lat: null, lon: null });
    await call('POST', `/api/v1/client/requests/${request.id}/submit`, clientToken, {
      operationId: randomUUID(),
      expectedVersion: request.version,
    });

    const after = await snapshot();
    const document = JSON.parse(after.payload ?? '{}') as {
      requests: Array<{ request_id: string }>;
    };
    assert.equal(
      document.requests.some((item) => item.request_id === request.id),
      false,
      'coordinates are never invented',
    );
    assert.ok(
      (after.diagnostics?.requestsWithoutLocation ?? 0) >
        (before.diagnostics?.requestsWithoutLocation ?? 0),
      'the exclusion has to be visible and counted, not silent',
    );
  });

  it('excludes an engineer with no usable start point', async () => {
    const before = await snapshot();
    const engineer = await createEngineer({ homeLat: null, homeLon: null }, false);

    const after = await snapshot();
    const document = JSON.parse(after.payload ?? '{}') as {
      engineers: Array<{ engineer_id: string }>;
    };
    assert.equal(
      document.engineers.some((item) => item.engineer_id === engineer.id),
      false,
    );
    assert.ok(
      (after.diagnostics?.engineersWithoutStartLocation ?? 0) >=
        (before.diagnostics?.engineersWithoutStartLocation ?? 0),
    );
  });

  it('keeps the published document free of customer data', async () => {
    const current = await snapshot();
    const payload = current.payload ?? '';
    // Names, problem text and addresses stay in the application and are looked up by id;
    // the sector carries the task and nothing else (context/33 section 5).
    assert.equal(payload.includes('Snapshot Customer'), false);
    assert.equal(payload.includes('Тестовая'), false);
    assert.equal(payload.includes('@example.test'), false);
    // And the hash is not part of its own input.
    assert.equal(payload.includes(current.inputHash ?? 'nothing'), false);
  });

  it('carries the policy in force and republishes when it changes', async () => {
    const before = await snapshot();
    const beforeDocument = JSON.parse(before.payload ?? '{}') as {
      policy: { policy_id: string };
    };
    assert.equal(beforeDocument.policy.policy_id, 'fast', 'the first default is fast');

    const response = await call('POST', '/api/v1/dispatch/policy', dispatcherToken, {
      operationId: randomUUID(),
      policyId: 'compact',
    });
    assert.equal(response.status, 201);

    const after = await snapshot();
    const afterDocument = JSON.parse(after.payload ?? '{}') as { policy: { policy_id: string } };
    assert.equal(afterDocument.policy.policy_id, 'compact');
    assert.equal(after.trigger, 'policy.changed');

    // Put the default back so the rest of the contour is unaffected.
    await call('POST', '/api/v1/dispatch/policy', dispatcherToken, {
      operationId: randomUUID(),
      policyId: 'fast',
    });
  });

  it('refuses a policy that is not in the catalogue', async () => {
    const response = await call('POST', '/api/v1/dispatch/policy', dispatcherToken, {
      operationId: randomUUID(),
      policyId: 'make-it-fast-somehow',
    });
    assert.equal(response.status, 422);
  });

  it('keeps every published snapshot and moves only the pointer', async () => {
    const countBefore = await prisma.routingSnapshot.count();
    const request = await createRequest();
    await call('POST', `/api/v1/client/requests/${request.id}/submit`, clientToken, {
      operationId: randomUUID(),
      expectedVersion: request.version,
    });

    const countAfter = await prisma.routingSnapshot.count();
    assert.ok(countAfter > countBefore, 'published snapshots are immutable and kept');

    // The pointer is checked against the published hash rather than against "the newest
    // row": timestamps are whole seconds, and two snapshots written in the same second
    // have no order between them.
    const pointer = await prisma.routingCurrent.findUniqueOrThrow({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    const published = await snapshot();
    assert.equal(pointer.snapshot.inputHash, published.inputHash);
    assert.ok(pointer.pointerVersion >= 1);
  });
});
