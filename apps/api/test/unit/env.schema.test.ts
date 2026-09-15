import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateEnv } from '../../src/common/config/env.schema';

describe('environment validation', () => {
  it('applies defaults for an empty environment', () => {
    const env = validateEnv({});
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.PORT, 8000);
    assert.equal(env.LOG_LEVEL, 'info');
  });

  it('coerces PORT from its string form', () => {
    assert.equal(validateEnv({ PORT: '9100' }).PORT, 9100);
  });

  it('stops the process on an unusable value and names the key', () => {
    assert.throws(() => validateEnv({ PORT: 'not-a-port' }), /PORT/);
    assert.throws(() => validateEnv({ LOG_LEVEL: 'chatty' }), /LOG_LEVEL/);
  });
});
