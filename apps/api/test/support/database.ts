import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

/**
 * Integration tests run against a real PostgreSQL, not SQLite and not a mock.
 *
 * Transactions, row locks, the exact stored payload bytes and the read-only role are
 * precisely what has to be verified, and none of them survives a substitute engine
 * (context/43 section 12).
 */

/** Minimal reader for the repository-root `.env`, so tests need no extra dependency. */
function loadRootEnv(): void {
  if (process.env.DATABASE_URL) {
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
    // An absent .env is fine; the check below produces the actionable message.
  }
}

export function databaseUrl(): string {
  loadRootEnv();
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests need a running database: ' +
        'run `cp .env.example .env` and `pnpm compose:up` first.',
    );
  }
  return url;
}

export function createTestClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl() }) });
}

/** Unique suffix so parallel test files never collide on a unique column. */
export function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
