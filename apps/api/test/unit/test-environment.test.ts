import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('explicit test database prevents loading developer service settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'lct-test-env-'));
  try {
    const cwd = join(root, 'apps/api');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(root, '.env'), 'SMTP_HOST=mail.example.invalid\nDEMO_STAND=true\n');
    const helper = resolve(__dirname, '../support/env.js');
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(helper)}); process.stdout.write(JSON.stringify({ database: process.env.DATABASE_URL, smtp: process.env.SMTP_HOST, demo: process.env.DEMO_STAND }));`,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: {
          DATABASE_URL: 'postgresql://unused/developer',
          TEST_DATABASE_URL: 'postgresql://unused/isolated',
        },
      },
    );
    assert.deepEqual(JSON.parse(output), { database: 'postgresql://unused/isolated' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('integration tests fail before boot without an isolated test database', () => {
  const helper = resolve(__dirname, '../support/env.js');
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(helper)})`], {
    encoding: 'utf8',
    env: { DATABASE_URL: 'postgresql://unused/developer' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TEST_DATABASE_URL is required/);
});
