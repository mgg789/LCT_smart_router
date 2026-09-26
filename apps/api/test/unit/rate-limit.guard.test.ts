import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SysError } from '../../src/common/errors';
import {
  PreAuthRateLimitGuard,
  RateLimitGuard,
  type RateLimitRule,
} from '../../src/common/rate-limit';
import type { PrismaService } from '../../src/persistence';

const RULE: RateLimitRule = { scope: 'test:scope', max: 2, windowSec: 60 };

interface GuardRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

/** A minimal execution context: only what the guard reads. */
function context(headers: Record<string, string>, ip = '10.0.0.1'): ExecutionContext {
  const request: GuardRequest = { headers, ip };
  return {
    getHandler: () => function handler() {},
    getClass: () => function klass() {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** A tiny serialized fake for the atomic SQL statement; real concurrency is covered by
 * the transaction queue, while the guard test remains independent of a live database. */
function fakeDatabase(): { prisma: PrismaService; maxConcurrency: () => number } {
  const buckets = new Map<string, number>();
  let active = 0;
  let maximum = 0;
  let tail = Promise.resolve();
  const prisma = {
    $queryRaw: async (...args: unknown[]): Promise<Array<{ count: number }>> => {
      const values = args.slice(1).map(String);
      const key = values.slice(0, 3).join(':');
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const count = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, count);
      active -= 1;
      release();
      return [{ count }];
    },
    $executeRaw: async (..._args: unknown[]): Promise<number> => 0,
  } as unknown as PrismaService;
  return { prisma, maxConcurrency: () => maximum };
}

function guard(reflector: Reflector): RateLimitGuard {
  return new RateLimitGuard(reflector, { get: () => 1 } as never, fakeDatabase().prisma);
}

describe('RateLimitGuard', () => {
  it('allows up to the budget inside one window and refuses past it', async () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = guard(reflector);

    assert.equal(await guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.equal(await guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    await assert.rejects(
      () => guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })),
      (error: unknown) => error instanceof SysError && error.code === 'RATE_LIMITED',
    );
  });

  it('ignores spoofed forwarded addresses and uses Express req.ip', async () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = guard(reflector);

    assert.equal(await guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.equal(await guarded.canActivate(context({ 'x-forwarded-for': '5.6.7.8' })), true);
    await assert.rejects(
      () => guarded.canActivate(context({ 'x-forwarded-for': '9.10.11.12' })),
      (error: unknown) => error instanceof SysError,
    );
    // A different socket peer starts its own budget.
    assert.equal(
      await guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.2')),
      true,
    );
  });

  it('opens a new window when the old one is over', async () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = guard(reflector);

    assert.equal(await guarded.canActivate(context({}, '1.2.3.4')), true);
    assert.equal(await guarded.canActivate(context({}, '1.2.3.4')), true);
    await assert.rejects(() => guarded.canActivate(context({}, '1.2.3.4')));

    // Fresh instance = fresh window; the guard keeps no state beyond the process.
    const reopened = guard(reflector);
    assert.equal(await reopened.canActivate(context({}, '1.2.3.4')), true);
  });

  it('passes routes without a rule through', async () => {
    const guarded = guard(new Reflector());
    assert.equal(await guarded.canActivate(context({})), true);
  });

  it('applies the pre-auth rule to the same bucket before credential resolution', async () => {
    const reflector = {
      getAllAndOverride: (_key: string) => (_key === 'pre_auth_rate_limit_rule' ? RULE : undefined),
    } as unknown as Reflector;
    const guarded = new PreAuthRateLimitGuard(
      reflector,
      { get: () => 1 } as never,
      fakeDatabase().prisma,
    );

    assert.equal(await guarded.canActivate(context({ 'x-mcp-pin': 'bad-pin' })), true);
    assert.equal(await guarded.canActivate(context({ authorization: 'Bearer bad-token' })), true);
    await assert.rejects(
      () => guarded.canActivate(context({ 'x-mcp-pin': 'another-bad-pin' })),
      (error: unknown) => error instanceof SysError && error.code === 'RATE_LIMITED',
    );
  });

  it('serializes concurrent requests through the database bucket', async () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const database = fakeDatabase();
    const guarded = new RateLimitGuard(reflector, { get: () => 1 } as never, database.prisma);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => guarded.canActivate(context({}))),
    );
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, RULE.max);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 6 - RULE.max);
    assert.equal(database.maxConcurrency(), 1);
  });
});
