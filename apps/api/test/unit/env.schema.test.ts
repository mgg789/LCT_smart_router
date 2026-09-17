import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateEnv } from '../../src/common/config/env.schema';
import { loadJsonFixture } from '../support/fixtures';

const fixtures = loadJsonFixture<{
  databaseUrl: string;
  dispatcherEmail: string;
  dispatcherPassword: string;
}>('env-fixtures.json');

/** The keys with no sensible default; everything else may be omitted. */
const REQUIRED = {
  DATABASE_URL: fixtures.databaseUrl,
  DISPATCHER_EMAIL: fixtures.dispatcherEmail,
  DISPATCHER_PASSWORD: fixtures.dispatcherPassword,
};

describe('environment validation', () => {
  it('applies defaults around the required keys', () => {
    const env = validateEnv({ ...REQUIRED });
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.PORT, 8000);
    assert.equal(env.LOG_LEVEL, 'info');
    assert.equal(env.MIGRATE_DATABASE_URL, undefined);
    assert.equal(env.ROUTER_BASE_URL, undefined);
    assert.equal(env.ROUTER_POLL_INTERVAL_MS, 500);
    assert.equal(env.ROUTER_REQUEST_TIMEOUT_MS, 3000);
  });

  it('coerces PORT from its string form', () => {
    assert.equal(validateEnv({ ...REQUIRED, PORT: '9100' }).PORT, 9100);
  });

  it('stops the process on an unusable value and names the key', () => {
    assert.throws(() => validateEnv({ ...REQUIRED, PORT: 'not-a-port' }), /PORT/);
    assert.throws(() => validateEnv({ ...REQUIRED, LOG_LEVEL: 'chatty' }), /LOG_LEVEL/);
    assert.throws(
      () => validateEnv({ ...REQUIRED, ROUTER_BASE_URL: 'file:///tmp/router' }),
      /ROUTER_BASE_URL/,
    );
  });

  it('refuses to start without a database connection rather than defaulting to one', () => {
    assert.throws(() => validateEnv({}), /DATABASE_URL/);
  });

  it('refuses to start without dispatcher credentials', () => {
    assert.throws(() => validateEnv({ DATABASE_URL: REQUIRED.DATABASE_URL }), /DISPATCHER_EMAIL/);
  });

  it('refuses to expose login codes in production', () => {
    // An exposed code is a complete authentication bypass, so this is a hard stop rather
    // than a warning.
    assert.throws(
      () => validateEnv({ ...REQUIRED, NODE_ENV: 'production', AUTH_DEV_EXPOSE_CODES: 'true' }),
      /AUTH_DEV_EXPOSE_CODES/,
    );
    assert.doesNotThrow(() =>
      validateEnv({ ...REQUIRED, NODE_ENV: 'production', AUTH_DEV_EXPOSE_CODES: 'false' }),
    );
  });
});
