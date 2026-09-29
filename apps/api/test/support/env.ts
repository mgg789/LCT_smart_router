import { resolve } from 'node:path';

/**
 * Sets the environment **before** the application module graph is imported.
 *
 * Nest's configuration is validated while `AppModule` is being imported, not when a test
 * body runs, so assigning `process.env` inside `before()` is too late. Importing this
 * module first is what makes an override actually apply; the side effect is the point.
 */

// An explicit disposable database is required. Falling back to the developer's
// .env allowed integration tests to mutate a running stand and inherit its auth state.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is required for integration tests. Run scripts/ci/run-js-tests.sh ' +
      'for an isolated Postgres sidecar, or provide a disposable migrated test database.',
  );
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.NODE_ENV = 'test';
// One integration run signs in repeatedly from the same loopback address.
process.env.RATE_LIMIT_MULTIPLIER = '1000';
// This build has no SMTP-gateway, so the login code has to come back in the response for
// any contour test to be able to sign anyone in.
process.env.AUTH_DEV_EXPOSE_CODES = 'true';
// The assistant runs against recorded fixtures in tests: a developer's live provider
// in this file would make the runs non-deterministic and cost real money.
process.env.LLM_PROVIDER = 'replay';
// Tests run from apps/api; the dataset lives at the repository root.
process.env.DATASET_ROOT = resolve(process.cwd(), '../../data/dataset/anonymized');
// AppModule tests use the deterministic in-process Router client. The real Docker Router is
// exercised by the repository smoke command and must not race database integration tests.
delete process.env.ROUTER_BASE_URL;
