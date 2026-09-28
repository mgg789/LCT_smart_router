import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('runtime DTO schemas load without deployment configuration or Nest bootstrap', () => {
  const directory = resolve(__dirname, '../../src/api/dto');
  const modules = readdirSync(directory)
    .filter((file) => file.endsWith('.dto.js'))
    .map((file) => join(directory, file));
  assert.ok(modules.length > 0);
  const result = spawnSync(
    process.execPath,
    ['-e', `for (const file of ${JSON.stringify(modules)}) require(file);`],
    {
      cwd: tmpdir(),
      env: {
        ...process.env,
        DATABASE_URL: undefined,
        DISPATCHER_EMAIL: undefined,
        DISPATCHER_PASSWORD: undefined,
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, 'DTO imports must not initialize deployment configuration');
});
