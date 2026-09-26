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

describe('RateLimitGuard', () => {
  it('allows up to the budget inside one window and refuses past it', () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = new RateLimitGuard(reflector, { get: () => 1 } as never);

    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.throws(
      () => guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })),
      (error: unknown) => error instanceof SysError && error.code === 'RATE_LIMITED',
    );
  });

  it('ignores spoofed forwarded addresses and uses Express req.ip', () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = new RateLimitGuard(reflector, { get: () => 1 } as never);

    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '5.6.7.8' })), true);
    assert.throws(
      () => guarded.canActivate(context({ 'x-forwarded-for': '9.10.11.12' })),
      (error: unknown) => error instanceof SysError,
    );
    // A different socket peer starts its own budget.
    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.2')), true);
  });

  it('opens a new window when the old one is over', () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = new RateLimitGuard(reflector, { get: () => 1 } as never);

    assert.equal(guarded.canActivate(context({}, '1.2.3.4')), true);
    assert.equal(guarded.canActivate(context({}, '1.2.3.4')), true);
    assert.throws(() => guarded.canActivate(context({}, '1.2.3.4')));

    // Fresh instance = fresh window; the guard keeps no state beyond the process.
    const reopened = new RateLimitGuard(reflector, { get: () => 1 } as never);
    assert.equal(reopened.canActivate(context({}, '1.2.3.4')), true);
  });

  it('passes routes without a rule through', () => {
    const guarded = new RateLimitGuard(new Reflector(), { get: () => 1 } as never);
    assert.equal(guarded.canActivate(context({})), true);
  });

  it('applies the pre-auth rule to the same bucket before credential resolution', () => {
    const reflector = {
      getAllAndOverride: (_key: string) => (_key === 'pre_auth_rate_limit_rule' ? RULE : undefined),
    } as unknown as Reflector;
    const guarded = new PreAuthRateLimitGuard(reflector, { get: () => 1 } as never);

    assert.equal(guarded.canActivate(context({ 'x-mcp-pin': 'bad-pin' })), true);
    assert.equal(guarded.canActivate(context({ authorization: 'Bearer bad-token' })), true);
    assert.throws(
      () => guarded.canActivate(context({ 'x-mcp-pin': 'another-bad-pin' })),
      (error: unknown) => error instanceof SysError && error.code === 'RATE_LIMITED',
    );
  });
});
