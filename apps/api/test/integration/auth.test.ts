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
import { loadJsonFixture } from '../support/fixtures';

interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
}

const fixtures = loadJsonFixture<{ wrongDispatcherPassword: string }>('env-fixtures.json');

// A fixed loopback port, sequential test runs (--test-concurrency=1): every request the
// suite issues targets this validated constant, never an interpolated host.
const BASE = 'http://127.0.0.1:4101';

/**
 * Acceptance scenarios for the auth-engine, taken from context/36 section 13.
 *
 * The suite runs against the real application and the real database: role granting,
 * single-use codes and token revocation are all statements about stored state, and a
 * mocked store would prove nothing about them.
 */
describe('auth-engine', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const createdEmails: string[] = [];

  // The suite talks to the app it just started; the request URL is always resolved
  // against the constant loopback base above.
  const target = (path: string): string => new URL(path, BASE).toString();

  const post = async (path: string, body: unknown, token?: string) =>
    fetch(target(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  const get = async (path: string, token?: string) =>
    fetch(target(path), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  /** Issues a code and reads it back through the development-only channel. */
  const codeFor = async (email: string): Promise<string> => {
    const response = await post('/api/v1/auth/login-code', { email });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { devCode?: string };
    assert.ok(body.devCode, 'AUTH_DEV_EXPOSE_CODES must be enabled for the test contour');
    return body.devCode;
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
    await app.listen(4101, '127.0.0.1');
  });

  after(async () => {
    if (createdEmails.length > 0) {
      await prisma.account.deleteMany({ where: { email: { in: createdEmails } } });
      await prisma.loginCode.deleteMany({ where: { email: { in: createdEmails } } });
    }
    await prisma.$disconnect();
    await app?.close();
  });

  it('creates a client account on the first successful verification', async () => {
    const email = `${unique('client')}@example.test`;
    createdEmails.push(email);

    const code = await codeFor(email);
    const response = await post('/api/v1/auth/login-code/verify', { email, code, role: 'client' });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { token: string; role: string };
    assert.equal(body.role, 'client');

    const session = await get('/api/v1/auth/session', body.token);
    assert.equal(session.status, 200);
    assert.equal(((await session.json()) as { role: string }).role, 'client');
  });

  it('does not create the engineer role for an address that types it in', async () => {
    const email = `${unique('stranger')}@example.test`;
    createdEmails.push(email);

    const code = await codeFor(email);
    const response = await post('/api/v1/auth/login-code/verify', {
      email,
      code,
      role: 'engineer',
    });

    // Rejected, and indistinguishable from a wrong code so the staff list does not leak
    // (context/36 section 13: "a client entered an email on the engineer sign-in screen").
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'UNAUTHENTICATED');
    const account = await prisma.account.findUnique({
      where: { email },
      include: { roles: true },
    });
    assert.equal(account, null);
  });

  it('accepts a code exactly once', async () => {
    const email = `${unique('replay')}@example.test`;
    createdEmails.push(email);

    const code = await codeFor(email);
    const first = await post('/api/v1/auth/login-code/verify', { email, code, role: 'client' });
    assert.equal(first.status, 201);

    const replay = await post('/api/v1/auth/login-code/verify', { email, code, role: 'client' });
    assert.equal(replay.status, 401);
  });

  it('retires an outstanding code when a new one is requested', async () => {
    const email = `${unique('reissue')}@example.test`;
    createdEmails.push(email);

    const first = await codeFor(email);
    const second = await codeFor(email);
    assert.notEqual(first, second);

    const withOld = await post('/api/v1/auth/login-code/verify', {
      email,
      code: first,
      role: 'client',
    });
    assert.equal(withOld.status, 401);

    const withNew = await post('/api/v1/auth/login-code/verify', {
      email,
      code: second,
      role: 'client',
    });
    assert.equal(withNew.status, 201);
  });

  it('stops accepting a code after too many wrong attempts', async () => {
    const email = `${unique('bruteforce')}@example.test`;
    createdEmails.push(email);

    const code = await codeFor(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post('/api/v1/auth/login-code/verify', {
        email,
        code: wrong,
        role: 'client',
      });
      assert.equal(response.status, 401);
    }

    const withCorrect = await post('/api/v1/auth/login-code/verify', {
      email,
      code,
      role: 'client',
    });
    assert.equal(withCorrect.status, 401, 'an exhausted code must stay unusable');
  });

  it('signs the dispatcher in by password without touching SMTP', async () => {
    const response = await post('/api/v1/auth/dispatcher/password', {
      email: process.env.DISPATCHER_EMAIL,
      password: process.env.DISPATCHER_PASSWORD,
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { token: string; role: string };
    assert.equal(body.role, 'dispatcher');

    const session = await get('/api/v1/auth/session', body.token);
    assert.equal(((await session.json()) as { role: string }).role, 'dispatcher');
  });

  it('refuses a wrong dispatcher password', async () => {
    const response = await post('/api/v1/auth/dispatcher/password', {
      email: process.env.DISPATCHER_EMAIL,
      password: fixtures.wrongDispatcherPassword,
    });
    assert.equal(response.status, 401);
  });

  it('closes an endpoint that carries no credential at all', async () => {
    const response = await get('/api/v1/auth/session');
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as ErrorBody).error.code, 'UNAUTHENTICATED');
  });

  it('rejects a revoked session instead of continuing anonymously', async () => {
    const email = `${unique('signout')}@example.test`;
    createdEmails.push(email);
    const code = await codeFor(email);
    const verify = await post('/api/v1/auth/login-code/verify', { email, code, role: 'client' });
    const { token } = (await verify.json()) as { token: string };

    const signOut = await fetch(target('/api/v1/auth/session'), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(signOut.status, 200);

    const afterSignOut = await get('/api/v1/auth/session', token);
    assert.equal(afterSignOut.status, 401);
  });

  describe('integration keys', () => {
    let dispatcherToken: string;

    before(async () => {
      const response = await post('/api/v1/auth/dispatcher/password', {
        email: process.env.DISPATCHER_EMAIL,
        password: process.env.DISPATCHER_PASSWORD,
      });
      dispatcherToken = ((await response.json()) as { token: string }).token;
    });

    it('creates a key from a name and a category, and shows the secret once', async () => {
      const created = await post(
        '/api/v1/auth/tokens',
        { name: unique('integration'), category: 'master' },
        dispatcherToken,
      );
      assert.equal(created.status, 201);
      const body = (await created.json()) as { id: string; token: string };
      assert.ok(body.token.length > 20);

      const listed = await get('/api/v1/auth/tokens', dispatcherToken);
      const { tokens } = (await listed.json()) as {
        tokens: Array<Record<string, unknown>>;
      };
      const entry = tokens.find((item) => item.id === body.id);
      assert.ok(entry);
      assert.equal(entry.token, undefined, 'a listing must never re-reveal the secret');
      assert.equal(entry.tokenHash, undefined);

      await fetch(target(`/api/v1/auth/tokens/${body.id}`), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${dispatcherToken}` },
      });
    });

    it('maps a master key onto the dispatcher role and a client key onto the client', async () => {
      const master = await post(
        '/api/v1/auth/tokens',
        { name: unique('master'), category: 'master' },
        dispatcherToken,
      );
      const masterKey = (await master.json()) as { id: string; token: string };

      const client = await post(
        '/api/v1/auth/tokens',
        { name: unique('client-key'), category: 'client' },
        dispatcherToken,
      );
      const clientKey = (await client.json()) as { id: string; token: string };

      const asMaster = await get('/api/v1/auth/session', masterKey.token);
      assert.equal(((await asMaster.json()) as { role: string }).role, 'dispatcher');

      const asClient = await get('/api/v1/auth/session', clientKey.token);
      assert.equal(((await asClient.json()) as { role: string }).role, 'client');

      // A client key never gains dispatcher functions just because the same person owns
      // it (context/41 section 5).
      const forbidden = await get('/api/v1/auth/tokens', clientKey.token);
      assert.equal(forbidden.status, 403);
      assert.equal(((await forbidden.json()) as ErrorBody).error.code, 'FORBIDDEN');

      for (const id of [masterKey.id, clientKey.id]) {
        await fetch(target(`/api/v1/auth/tokens/${id}`), {
          method: 'DELETE',
          headers: { authorization: `Bearer ${dispatcherToken}` },
        });
      }
    });

    it('stops accepting a revoked key without deleting what it created', async () => {
      const created = await post(
        '/api/v1/auth/tokens',
        { name: unique('revoked'), category: 'master' },
        dispatcherToken,
      );
      const key = (await created.json()) as { id: string; token: string };

      assert.equal((await get('/api/v1/auth/session', key.token)).status, 200);

      const revoked = await fetch(target(`/api/v1/auth/tokens/${key.id}`), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${dispatcherToken}` },
      });
      assert.equal(revoked.status, 200);

      assert.equal((await get('/api/v1/auth/session', key.token)).status, 401);

      // The record survives revocation, so the journal can still explain past changes.
      const stored = await prisma.apiToken.findUnique({ where: { id: key.id } });
      assert.ok(stored);
      assert.notEqual(stored.revokedAt, null);
    });

    it('does not let an integration key manage integration keys', async () => {
      const created = await post(
        '/api/v1/auth/tokens',
        { name: unique('self-manage'), category: 'master' },
        dispatcherToken,
      );
      const key = (await created.json()) as { id: string; token: string };

      const attempt = await post(
        '/api/v1/auth/tokens',
        { name: unique('nested'), category: 'client' },
        key.token,
      );
      assert.equal(attempt.status, 201, 'creating is a master-category function');

      const nested = (await attempt.json()) as { id: string };
      const revokeAttempt = await fetch(target(`/api/v1/auth/tokens/${nested.id}`), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${key.token}` },
      });
      assert.equal(revokeAttempt.status, 403);

      for (const id of [key.id, nested.id]) {
        await fetch(target(`/api/v1/auth/tokens/${id}`), {
          method: 'DELETE',
          headers: { authorization: `Bearer ${dispatcherToken}` },
        });
      }
    });
  });
});
