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
// Tests run from apps/api; the dataset lives at the repository root.
process.env.DATASET_ROOT = resolve(process.cwd(), '../../data/dataset/anonymized');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Integration tests need a running database: ' +
      'run `cp .env.example .env` and `pnpm compose:up` first.',
  );
}
