import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Actor } from '../../src/auth';
import { SysError } from '../../src/common/errors';
import { OperationsService } from '../../src/operations/operations.service';

const actor: Actor = {
  kind: 'account',
  source: 'ui',
  id: 'actor-1',
  role: 'dispatcher',
  tokenCategory: null,
  accountId: 'account-1',
};

/**
 * Records which transaction boundary an operation used.
 *
 * Email saves must not enter `run`: that boundary reserves the routing rows a
 * plan acceptance is already holding.
 */
interface FakeTx {
  operation: { create: () => Promise<unknown> };
  auditLog: { create: () => Promise<unknown> };
}

function harness() {
  const boundaries: string[] = [];
  const tx: FakeTx = {
    operation: {
      create: async () => ({}),
    },
    auditLog: {
      create: async () => ({}),
    },
  };
  const uow = {
    async run<T>(fn: (current: FakeTx) => Promise<T>): Promise<T> {
      boundaries.push('run');
      return fn(tx);
    },
    async runIsolated<T>(fn: (current: FakeTx) => Promise<T>): Promise<T> {
      boundaries.push('isolated');
      return fn(tx);
    },
  };
  const service = new OperationsService(
    { operation: { findUnique: async () => null } } as never,
    uow as never,
    { nowSeconds: () => 1 } as never,
    { record: async () => undefined } as never,
  );
  return { service, boundaries };
}

describe('account writes stay off the routing lock', () => {
  it('uses the isolated boundary when asked', async () => {
    const { service, boundaries } = harness();
    const outcome = await service.execute(
      {
        operationId: 'op-email',
        actor,
        action: 'engineer.link_account',
        payload: { email: 'mm@mm.mm' },
      },
      async () => 'saved',
      { isolated: true },
    );
    assert.equal(outcome.result, 'saved');
    assert.deepEqual(boundaries, ['isolated']);
  });

  it('still reserves the routing rows for a plan write', async () => {
    const { service, boundaries } = harness();
    await service.execute(
      {
        operationId: 'op-plan',
        actor,
        action: 'live.workday.start',
        payload: {},
      },
      async () => 'started',
    );
    assert.deepEqual(boundaries, ['run']);
  });

  it('journals a refusal on the same isolated boundary', async () => {
    const { service, boundaries } = harness();
    await assert.rejects(
      service.execute(
        {
          operationId: 'op-email-refused',
          actor,
          action: 'engineer.change_email',
          payload: { email: 'mm@mm.mm' },
        },
        async () => {
          throw new SysError('VALIDATION_FAILED', 'This engineer has no login to replace');
        },
        { isolated: true },
      ),
      (error: unknown) => error instanceof SysError,
    );
    assert.deepEqual(boundaries, ['isolated', 'isolated']);
  });
});
