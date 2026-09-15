import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/errors';
import { BigIntGuardInterceptor } from '../../src/common/serialization';

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
    app = await NestFactory.create(AppModule, { logger: false });
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

  it('is ready when nothing required is registered yet', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { status: string }).status, 'ok');
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
      { router: 'not_configured', ai: 'not_configured', smtp: 'not_configured' },
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
});
