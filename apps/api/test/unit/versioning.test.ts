import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SysError } from '../../src/common/errors';
import { assertExpectedVersion, assertWriteApplied } from '../../src/operations/versioning';

describe('optimistic concurrency', () => {
  it('accepts a matching version', () => {
    assert.doesNotThrow(() => assertExpectedVersion('Request', 4, 4));
  });

  it('reports a conflict with both versions so the caller can refresh deliberately', () => {
    try {
      assertExpectedVersion('Request', 3, 5);
      assert.fail('expected a conflict');
    } catch (error) {
      assert.ok(error instanceof SysError);
      assert.equal(error.code, 'VERSION_CONFLICT');
      assert.deepEqual(error.details, { expectedVersion: 3, currentVersion: 5 });
    }
  });

  it('skips the check when the action does not follow from a prior read', () => {
    // context/36 section 12 marks expectedVersion as required only "when needed".
    assert.doesNotThrow(() => assertExpectedVersion('Request', undefined, 5));
    assert.doesNotThrow(() => assertExpectedVersion('Request', null, 5));
  });

  it('treats a conditional write that matched nothing as a conflict, not a retry', () => {
    assert.throws(
      () => assertWriteApplied('Request', 0, 3, 5),
      (error: unknown) => error instanceof SysError && error.code === 'VERSION_CONFLICT',
    );
    assert.doesNotThrow(() => assertWriteApplied('Request', 1, 3, 3));
  });
});
