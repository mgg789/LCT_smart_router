import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Sets the environment **before** the application module graph is imported.
 *
 * Nest's configuration is validated while `AppModule` is being imported, not when a test
 * body runs, so assigning `process.env` inside `before()` is too late. Importing this
 * module first is what makes an override actually apply; the side effect is the point.
 */

function loadRootEnv(): void {
  // An explicitly isolated test database must never inherit the developer's
  // provider, mail, or demo settings from the local application environment.
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    return;
  }
  try {
    const content = readFileSync(resolve(process.cwd(), '../../.env'), 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      const key = match?.[1];
      if (key && !process.env[key]) {
        process.env[key] = match?.[2]?.trim() ?? '';
      }
    }
  } catch {
    // Absent .env is fine; the checks below produce actionable messages.
  }
}

loadRootEnv();

process.env.NODE_ENV = 'test';
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

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Integration tests need a running database: ' +
      'run `cp .env.example .env` and `pnpm compose:up` first.',
  );
}
