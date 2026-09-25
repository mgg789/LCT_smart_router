import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { guardAllows } from '../../src/ai/operations/action-guard';

describe('action guard', () => {
  it('applies only a clear yes from System one', () => {
    assert.equal(guardAllows(0.5), true);
    assert.equal(guardAllows(0.91), true);
    assert.equal(guardAllows(0.49), false);
    assert.equal(guardAllows(null), false);
  });
});
