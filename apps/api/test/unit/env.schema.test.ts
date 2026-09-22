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
    assert.equal(env.LOCATION_IQ_TOKEN, undefined);
    assert.equal(env.DEMO_STAND, false);
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

  it('refuses a partial SMTP configuration', () => {
    assert.throws(
      () => validateEnv({ ...REQUIRED, SMTP_HOST: '127.0.0.1', SMTP_USER: 'navix-sys' }),
      /SMTP_PASSWORD/,
    );
    assert.doesNotThrow(() => validateEnv({ ...REQUIRED }));
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

  describe('AI-gateway', () => {
    it('defaults to an offline, unconfigured contour that needs no key', () => {
      const env = validateEnv({ ...REQUIRED });
      assert.equal(env.LLM_PROVIDER, 'off');
      assert.equal(env.LLM_TOKEN, undefined);
      assert.equal(env.LLM_FALLBACK_PROVIDER, 'none');
      assert.equal(env.LLM_MAX_ATTEMPTS, 2);
      assert.equal(env.AI_REPLAY_DIR, 'apps/api/test/fixtures/ai');
      assert.equal(env.AI_DEBUG_PROMPTS, false);
    });

    it('lets the offline replay provider run with no LLM_TOKEN at all', () => {
      assert.doesNotThrow(() => validateEnv({ ...REQUIRED, LLM_PROVIDER: 'replay' }));
    });

    it('refuses a live primary provider without LLM_TOKEN', () => {
      assert.throws(() => validateEnv({ ...REQUIRED, LLM_PROVIDER: 'agents' }), /LLM_TOKEN/);
      assert.throws(() => validateEnv({ ...REQUIRED, LLM_PROVIDER: 'openai_chat' }), /LLM_TOKEN/);
      assert.doesNotThrow(() =>
        validateEnv({ ...REQUIRED, LLM_PROVIDER: 'openai_chat', LLM_TOKEN: 'sk-test' }),
      );
    });

    it('refuses an openai_chat fallback without LLM_TOKEN', () => {
      assert.throws(
        () =>
          validateEnv({
            ...REQUIRED,
            LLM_PROVIDER: 'replay',
            LLM_FALLBACK_PROVIDER: 'openai_chat',
            LLM_MAX_ATTEMPTS: '2',
          }),
        /LLM_TOKEN/,
      );
      assert.doesNotThrow(() =>
        validateEnv({
          ...REQUIRED,
          LLM_PROVIDER: 'replay',
          LLM_FALLBACK_PROVIDER: 'openai_chat',
          LLM_TOKEN: 'sk-test',
          LLM_MAX_ATTEMPTS: '2',
        }),
      );
    });

    it('refuses a configured fallback with fewer than two attempts in the shared budget', () => {
      assert.throws(
        () =>
          validateEnv({
            ...REQUIRED,
            LLM_PROVIDER: 'replay',
            LLM_FALLBACK_PROVIDER: 'replay',
            LLM_MAX_ATTEMPTS: '1',
          }),
        /LLM_MAX_ATTEMPTS/,
      );
      assert.doesNotThrow(() =>
        validateEnv({
          ...REQUIRED,
          LLM_PROVIDER: 'replay',
          LLM_FALLBACK_PROVIDER: 'replay',
          LLM_MAX_ATTEMPTS: '2',
        }),
      );
    });

    it('refuses to log full prompts in production', () => {
      assert.throws(
        () =>
          validateEnv({
            ...REQUIRED,
            NODE_ENV: 'production',
            LLM_PROVIDER: 'replay',
            AI_DEBUG_PROMPTS: 'true',
          }),
        /AI_DEBUG_PROMPTS/,
      );
      assert.doesNotThrow(() =>
        validateEnv({
          ...REQUIRED,
          NODE_ENV: 'production',
          LLM_PROVIDER: 'replay',
          AI_DEBUG_PROMPTS: 'false',
        }),
      );
    });
  });

  it('enables the public demo stand only when the flag is true', () => {
    assert.equal(validateEnv({ ...REQUIRED, DEMO_STAND: 'true' }).DEMO_STAND, true);
    assert.equal(validateEnv({ ...REQUIRED, DEMO_STAND: 'false' }).DEMO_STAND, false);
  });
});
