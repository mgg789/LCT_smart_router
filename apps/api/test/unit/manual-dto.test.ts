import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { reassignSchema, reorderSchema, setModeSchema } from '../../src/api/dto/plan.dto';

describe('manual operation admission', () => {
  const base = { operationId: randomUUID(), expectedModeVersion: 1, expectedPlanRevision: 4 };

  it('requires a nonblank reason for MANUAL and trims the recorded reason', () => {
    for (const reason of [undefined, '', '  \n ']) {
      assert.equal(setModeSchema.safeParse({ ...base, mode: 'manual', reason }).success, false);
    }
    const accepted = setModeSchema.parse({
      ...base,
      mode: 'manual',
      reason: '  customer called  ',
    });
    assert.equal('reason' in accepted && accepted.reason, 'customer called');
    assert.equal(setModeSchema.safeParse({ ...base, mode: 'auto' }).success, true);
  });

  it('requires the versions that the dispatcher actually saw', () => {
    assert.equal(
      setModeSchema.safeParse({ operationId: base.operationId, mode: 'auto' }).success,
      false,
    );
    assert.equal(
      reassignSchema.safeParse({ operationId: base.operationId, requestId: 'r', engineerId: 'e' })
        .success,
      false,
    );
    assert.equal(
      reorderSchema.safeParse({ operationId: base.operationId, engineerId: 'e', requestIds: ['r'] })
        .success,
      false,
    );
  });

  it('refuses duplicate request ids in a reorder', () => {
    assert.equal(
      reorderSchema.safeParse({ ...base, engineerId: 'e', requestIds: ['r', 'r'] }).success,
      false,
    );
  });
});
