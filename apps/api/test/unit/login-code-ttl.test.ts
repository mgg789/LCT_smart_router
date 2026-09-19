import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOGIN_CODE_TTL_SEC, loginCodeStillLive } from '../../src/auth/login-code.service';

describe('login code TTL', () => {
  it('keeps a code live for 90 seconds and not a second longer', () => {
    assert.equal(LOGIN_CODE_TTL_SEC, 90);
    assert.equal(loginCodeStillLive(1_000, 999), true);
    assert.equal(loginCodeStillLive(1_000, 1_000), false);
  });
});
