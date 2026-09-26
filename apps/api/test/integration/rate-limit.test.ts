import '../support/env';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { AppConfigService } from '../../src/common/config';
import { RateLimitGuard, type RateLimitRule } from '../../src/common/rate-limit';
import { PrismaService } from '../../src/persistence';
import { databaseUrl } from '../support/database';

const RULE: RateLimitRule = { scope: 'integration:durable-rate-limit', max: 3, windowSec: 60 };

interface GuardRequest {
  readonly headers: Record<string, string>;
  readonly ip: string;
}

function context(ip: string) {
  const request: GuardRequest = { headers: {}, ip };
  return {
    getHandler: () => function handler() {},
    getClass: () => function klass() {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

/**
 * Runs two independent guard instances against one PostgreSQL bucket. This proves the
 * limit survives a process-local guard restart and that concurrent instances cannot both
 * pass a read-then-write check.
 */
describe('durable rate limit', () => {
  let app: INestApplication;
  let first: PrismaService;
  let second: PrismaService;

  before(async () => {
    process.env.NODE_ENV = 'test';
    databaseUrl();
    app = await NestFactory.create(AppModule, { logger: false });
    first = app.get(PrismaService);
    const config = app.get(AppConfigService);
    second = new PrismaService(config);
    await second.$connect();
  });

  after(async () => {
    if (first) {
      await first.$executeRaw`DELETE FROM rate_limit_buckets WHERE scope = ${RULE.scope}`;
    }
    if (second) {
      await second.$disconnect();
    }
    await app?.close();
  });

  it('shares one budget across concurrent guard instances and later instances', async () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const config = { get: () => 1 } as never;
    const left = new RateLimitGuard(reflector, config, first);
    const right = new RateLimitGuard(reflector, config, second);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? left : right).canActivate(context('198.51.100.20')),
      ),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, RULE.max);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 10 - RULE.max);

    const restarted = new RateLimitGuard(reflector, config, first);
    await assert.rejects(() => restarted.canActivate(context('198.51.100.20')));
  });
});
