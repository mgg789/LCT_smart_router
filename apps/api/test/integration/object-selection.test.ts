import '../support/env';
import assert from 'node:assert/strict';
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

// A fixed loopback port of its own, sequential runs (--test-concurrency=1): every
// request targets this validated constant.
const BASE = 'http://127.0.0.1:4103';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * The two ways an external application reaches the client and engineer contours
 * (context/41 section 3.2 as implemented for DRO-36 follow-up):
 *   * object selection -- an integration key names `clientEmail` / `engineerId`;
 *   * a session -- the subject comes from the credential and the payload may not
 *     override it (context/42 DF-06).
 */
describe('external object selection', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dispatcherToken: string;
  const createdEmails: string[] = [];
  const createdTokenIds: string[] = [];
  const createdEngineerIds: string[] = [];

  const target = (path: string): string => new URL(path, BASE).toString();

  const request = async (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<Response> =>
    fetch(target(path), {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const createKey = async (
    name: string,
    category: string,
  ): Promise<{ id: string; token: string }> => {
    const response = await request(
      'POST',
      '/api/v1/auth/tokens',
      { name, category },
      dispatcherToken,
    );
    assert.equal(response.status, 201);
    const created = (await response.json()) as { id: string; token: string };
    createdTokenIds.push(created.id);
    return created;
  };

  /** Issues a login code and exchanges it for a session of the given role. */
  const sessionFor = async (email: string, role: 'client' | 'engineer'): Promise<string> => {
    const codeResponse = await request('POST', '/api/v1/auth/login-code', { email });
    assert.equal(codeResponse.status, 201);
    const { devCode } = (await codeResponse.json()) as { devCode?: string };
    assert.ok(devCode, 'AUTH_DEV_EXPOSE_CODES must be enabled for the test contour');
    const verify = await request('POST', '/api/v1/auth/login-code/verify', {
      email,
      code: devCode,
      role,
    });
    assert.equal(verify.status, 201);
    return ((await verify.json()) as { token: string }).token;
  };

  const createEngineer = async (email: string): Promise<string> => {
    const response = await request(
      'POST',
      '/api/v1/dispatch/engineers',
      {
        operationId: crypto.randomUUID(),
        email,
        displayName: unique('Crew'),
        skills: ['local'],
        transportType: 'car',
      },
      dispatcherToken,
    );
    assert.equal(response.status, 201);
    const { engineer } = (await response.json()) as { engineer: { id: string } };
    createdEngineerIds.push(engineer.id);
    return engineer.id;
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
    await app.listen(4103, '127.0.0.1');

    const signIn = await request('POST', '/api/v1/auth/dispatcher/password', {
      email: process.env.DISPATCHER_EMAIL,
      password: process.env.DISPATCHER_PASSWORD,
    });
    dispatcherToken = ((await signIn.json()) as { token: string }).token;
  });

  after(async () => {
    if (createdTokenIds.length > 0) {
      await prisma.apiToken.deleteMany({ where: { id: { in: createdTokenIds } } });
    }
    if (createdEngineerIds.length > 0) {
      await prisma.engineerDay.deleteMany({ where: { engineerId: { in: createdEngineerIds } } });
      await prisma.engineer.deleteMany({ where: { id: { in: createdEngineerIds } } });
    }
    if (createdEmails.length > 0) {
      await prisma.request.deleteMany({ where: { clientAccountId: { in: await accountIds() } } });
      await prisma.account.deleteMany({ where: { email: { in: createdEmails } } });
    }
    await prisma.$disconnect();
    await app?.close();
  });

  const accountIds = async (): Promise<string[]> => {
    const rows = await prisma.account.findMany({
      where: { email: { in: createdEmails } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  };

  describe('an integration key names its object', () => {
    it('acts on the engineer by id with an eng key', async () => {
      const engineerEmail = `${unique('eng')}@example.test`;
      createdEmails.push(engineerEmail);
      const engineerId = await createEngineer(engineerEmail);
      const key = await createKey(unique('eng-key'), 'eng');

      const profile = await request(
        'GET',
        `/api/v1/engineer/profile?engineerId=${engineerId}`,
        undefined,
        key.token,
      );
      assert.equal(profile.status, 200);
      assert.equal(
        ((await profile.json()) as { engineer: { id: string } }).engineer.id,
        engineerId,
      );

      // Without a named object a key has no subject: refused as a caller error.
      const anonymous = await request('GET', '/api/v1/engineer/profile', undefined, key.token);
      assert.equal(anonymous.status, 422);
      assert.equal(((await anonymous.json()) as ErrorBody).error.code, 'VALIDATION_FAILED');

      // A named object must exist: a wrong id is a miss, not a permission problem.
      const missing = await request(
        'GET',
        `/api/v1/engineer/profile?engineerId=no-such-engineer`,
        undefined,
        key.token,
      );
      assert.equal(missing.status, 404);

      const day = await request(
        'GET',
        `/api/v1/engineer/day?engineerId=${engineerId}`,
        undefined,
        key.token,
      );
      assert.equal(day.status, 200);

      const offline = await request(
        'POST',
        '/api/v1/engineer/availability',
        { operationId: crypto.randomUUID(), engineerId, availability: 'offline' },
        key.token,
      );
      assert.equal(offline.status, 201);

      const lunch = await request(
        'POST',
        '/api/v1/engineer/lunch/start',
        { operationId: crypto.randomUUID() },
        key.token,
      );
      assert.equal(lunch.status, 422, 'an action without the named object has no subject');
    });

    it('prepares and lists a customer request by email with a client key', async () => {
      const customerEmail = `${unique('client')}@example.test`;
      createdEmails.push(customerEmail);
      const key = await createKey(unique('client-key'), 'client');

      const prepare = await request(
        'POST',
        '/api/v1/client/requests',
        {
          operationId: crypto.randomUUID(),
          clientEmail: customerEmail,
          contactName: 'Внешний клиент',
          addressText: 'Москва, ул. Тверская, 1',
          workType: 'connection_request',
          windowStartAt: nowSeconds() + 3_600,
          windowEndAt: nowSeconds() + 7_200,
          urgent: false,
        },
        key.token,
      );
      assert.equal(prepare.status, 201);
      const draft = ((await prepare.json()) as { request: { id: string; lifecycle: string } })
        .request;
      assert.equal(draft.lifecycle, 'draft');

      const submit = await request(
        'POST',
        `/api/v1/client/requests/${draft.id}/submit`,
        { operationId: crypto.randomUUID() },
        key.token,
      );
      assert.equal(submit.status, 201);
      assert.equal(
        ((await submit.json()) as { request: { lifecycle: string } }).request.lifecycle,
        'submitted',
      );

      const listed = await request(
        'GET',
        `/api/v1/client/requests?clientEmail=${encodeURIComponent(customerEmail)}`,
        undefined,
        key.token,
      );
      assert.equal(listed.status, 200);
      const { requests } = (await listed.json()) as { requests: Array<{ id: string }> };
      assert.ok(requests.some((item) => item.id === draft.id));

      const anonymousList = await request('GET', '/api/v1/client/requests', undefined, key.token);
      assert.equal(anonymousList.status, 422, 'a key without a named customer has nothing to list');
    });

    it('lets a client_eng key work both contours by object', async () => {
      const engineerEmail = `${unique('both')}@example.test`;
      createdEmails.push(engineerEmail);
      const engineerId = await createEngineer(engineerEmail);
      const customerEmail = `${unique('both-client')}@example.test`;
      createdEmails.push(customerEmail);
      const key = await createKey(unique('both-key'), 'client_eng');

      const profile = await request(
        'GET',
        `/api/v1/engineer/profile?engineerId=${engineerId}`,
        undefined,
        key.token,
      );
      assert.equal(profile.status, 200);

      const prepare = await request(
        'POST',
        '/api/v1/client/requests',
        {
          operationId: crypto.randomUUID(),
          clientEmail: customerEmail,
          contactName: 'Комбинированный ключ',
          addressText: 'Москва, ул. Мясницкая, 35',
          workType: 'connection_request',
          windowStartAt: nowSeconds() + 3_600,
          windowEndAt: nowSeconds() + 7_200,
        },
        key.token,
      );
      assert.equal(prepare.status, 201);
    });
  });

  describe('a session keeps its own subject', () => {
    it('refuses a client session that tries to act for another address', async () => {
      const email = `${unique('session-client')}@example.test`;
      createdEmails.push(email);
      const token = await sessionFor(email, 'client');

      const hijack = await request(
        'POST',
        '/api/v1/client/requests',
        {
          operationId: crypto.randomUUID(),
          clientEmail: `${unique('victim')}@example.test`,
          contactName: 'Не владелец сессии',
          addressText: 'Москва, ул. Тверская, 1',
          workType: 'connection_request',
          windowStartAt: nowSeconds() + 3_600,
          windowEndAt: nowSeconds() + 7_200,
        },
        token,
      );
      assert.equal(hijack.status, 403);
      assert.equal(((await hijack.json()) as ErrorBody).error.code, 'FORBIDDEN');

      const own = await request(
        'POST',
        '/api/v1/client/requests',
        {
          operationId: crypto.randomUUID(),
          contactName: 'Владелец сессии',
          addressText: 'Москва, ул. Тверская, 1',
          workType: 'connection_request',
          windowStartAt: nowSeconds() + 3_600,
          windowEndAt: nowSeconds() + 7_200,
        },
        token,
      );
      assert.equal(own.status, 201);
    });

    it('refuses an engineer session that names another engineer', async () => {
      const strangerId = await createEngineer(`${unique('stranger')}@example.test`);
      // The session's own engineer: created by the dispatcher, so the address carries the
      // engineer role and signing in proves nothing new about strangers.
      const email = `${unique('session-eng')}@example.test`;
      createdEmails.push(email);
      const ownId = await createEngineer(email);
      const token = await sessionFor(email, 'engineer');
      assert.notEqual(ownId, strangerId);

      const stranger = await request(
        'GET',
        `/api/v1/engineer/profile?engineerId=${strangerId}`,
        undefined,
        token,
      );
      assert.equal(stranger.status, 403);

      const own = await request('GET', '/api/v1/engineer/profile', undefined, token);
      assert.equal(own.status, 200);
      const profile = (await own.json()) as { engineer: { id: string } };
      assert.equal(profile.engineer.id, ownId);
    });
  });
});
