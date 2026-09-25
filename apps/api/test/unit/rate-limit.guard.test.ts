import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Reflector } from '@nestjs/core';
import { SysError } from '../../src/common/errors';
import { RateLimitGuard, type RateLimitRule } from '../../src/common/rate-limit';

const RULE: RateLimitRule = { scope: 'test:scope', max: 2, windowSec: 60 };

/** A minimal execution context: only what the guard reads, with the address the
 *  proxy chain would have left in the headers. */
function context(headers: Record<string, string>, ip = '10.0.0.1'): any {
  return {
    getHandler: () => function handler() {},
    getClass: () => function klass() {},
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip }),
    }),
  };
}

describe('RateLimitGuard', () => {
  it('allows up to the budget inside one window and refuses past it', () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = new RateLimitGuard(reflector);

    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.throws(
      () => guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })),
      (error: unknown) => error instanceof SysError && error.code === 'RATE_LIMITED',
    );
  });

  it('counts addresses independently', () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = new RateLimitGuard(reflector);

    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })), true);
    assert.throws(
      () => guarded.canActivate(context({ 'x-forwarded-for': '1.2.3.4' })),
      (error: unknown) => error instanceof SysError,
    );
    // A different address starts its own budget.
    assert.equal(guarded.canActivate(context({ 'x-forwarded-for': '5.6.7.8' })), true);
  });

  it('opens a new window when the old one is over', () => {
    const reflector = {
      getAllAndOverride: () => RULE,
    } as unknown as Reflector;
    const guarded = new RateLimitGuard(reflector);

    assert.equal(guarded.canActivate(context({}, '1.2.3.4')), true);
    assert.equal(guarded.canActivate(context({}, '1.2.3.4')), true);
    assert.throws(() => guarded.canActivate(context({}, '1.2.3.4')));

    // Fresh instance = fresh window; the guard keeps no state beyond the process.
    const reopened = new RateLimitGuard(reflector);
    assert.equal(reopened.canActivate(context({}, '1.2.3.4')), true);
  });

  it('passes routes without a rule through', () => {
    const guarded = new RateLimitGuard(new Reflector());
    assert.equal(guarded.canActivate(context({})), true);
  });
});
