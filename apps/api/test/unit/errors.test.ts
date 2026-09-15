import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_CODES, httpStatusForErrorCode } from '../../src/common/errors/error-codes';
import { SysError } from '../../src/common/errors/sys.error';

describe('error catalogue', () => {
  it('keeps distinguishable conflicts on the same status but different codes', () => {
    const conflicts = (
      ['VERSION_CONFLICT', 'WORK_ALREADY_STARTED', 'MODE_MANUAL', 'SNAPSHOT_STALE'] as const
    ).map(httpStatusForErrorCode);
    assert.deepEqual(conflicts, [409, 409, 409, 409]);
    assert.equal(new Set(Object.keys(ERROR_CODES)).size, Object.keys(ERROR_CODES).length);
  });

  it('carries the current version so the caller can refresh deliberately', () => {
    const error = SysError.versionConflict('Request', 3, 5);
    assert.equal(error.code, 'VERSION_CONFLICT');
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { expectedVersion: 3, currentVersion: 5 });
  });

  it('reports a missing integration as not configured rather than as success', () => {
    const error = SysError.notConfigured('Router Core');
    assert.equal(error.code, 'SERVICE_NOT_CONFIGURED');
    assert.equal(error.status, 503);
  });
});
