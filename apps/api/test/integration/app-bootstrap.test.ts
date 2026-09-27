import '../support/env';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/common/config';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';
import { applySecurityHeaders } from '../../src/main';
import { PrismaService } from '../../src/persistence';
import { databaseUrl } from '../support/database';

/**
 * Boots the real application the way `main.ts` does and talks to it over HTTP.
 *
 * This is the check that the Nest decorator/metadata build actually produces a working
 * dependency graph — a compile alone does not prove that (context/43 section 12).
 */
describe('application bootstrap', () => {
  let app: INestApplication;
  let baseUrl: string;

  before(async () => {
    process.env.NODE_ENV = 'test';
    // The real module graph includes persistence, so the application needs a database
    // exactly as it does in production. This is the point of the test. Configuration is
    // validated while the module is imported, so the value must already be in the
    // environment or in the repository-root .env by then; the call below turns a missing
    // one into an actionable message.
    databaseUrl();
    app = await NestFactory.create(AppModule, { logger: false });
    applySecurityHeaders(app, app.get(AppConfigService).isProduction);
    app.setGlobalPrefix('api/v1', {
      exclude: ['health/live', 'health/ready', 'health/services'],
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new BigIntGuardInterceptor(true));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app?.close();
  });

  it('answers liveness', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; uptimeSec: number };
    assert.equal(body.status, 'ok');
    assert.ok(Number.isInteger(body.uptimeSec));
  });

  it('is ready when the one required dependency answers', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      checks: Record<string, { status: string }>;
    };
    assert.equal(body.status, 'ok');
    // Only the database gates readiness: an unreachable SMTP or LLM must never make the
    // application look down (context/43 section 11.3).
    assert.deepEqual(Object.keys(body.checks), ['database']);
  });

  it('names the integrations that are not wired in this build', async () => {
    const response = await fetch(`${baseUrl}/health/services`);
    const body = (await response.json()) as {
      services: Record<string, { status: string }>;
    };
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(body.services).map(([name, health]) => [name, health.status]),
      ),
      {
        router: 'not_configured',
        // The test harness pins LLM_PROVIDER=replay, which reports as a wired provider.
        ai: 'ok',
        smtp: 'not_configured',
        database: 'ok',
      },
    );
  });

  it('returns the single error envelope with a request id for an unknown route', async () => {
    const response = await fetch(`${baseUrl}/api/v1/nope`, {
      headers: { 'x-request-id': 'trace-42' },
    });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-request-id'), 'trace-42');
    const body = (await response.json()) as {
      error: { code: string; requestId: string; details: unknown };
    };
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.requestId, 'trace-42');
    assert.deepEqual(body.error.details, {});
  });

  it('sets API security headers without forcing local HTTP onto HTTPS', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('strict-transport-security'), null);
  });

  it('counts one HTTP login attempt exactly once in the shared budget', async () => {
    const prisma = app.get(PrismaService);
    const before = await prisma.rateLimitBucket.aggregate({
      where: { scope: 'auth:password' },
      _sum: { count: true },
    });
    // Invalid input exercises the real global guards without creating an account/session.
    await fetch(`${baseUrl}/api/v1/auth/dispatcher/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const after = await prisma.rateLimitBucket.aggregate({
      where: { scope: 'auth:password' },
      _sum: { count: true },
    });
    assert.equal((after._sum.count ?? 0) - (before._sum.count ?? 0), 1);
  });
});
