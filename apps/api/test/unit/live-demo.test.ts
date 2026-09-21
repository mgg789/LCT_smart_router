import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { uploadDataPackageSchema } from '../../src/api/dto/data.dto';
import { buildLiveDemo } from '../../src/orchestrator/demo-stand/live-demo-package';

const datasetRoot = resolve(__dirname, '../../../../..', 'data/dataset/anonymized');

test('LIVE fixture supplies 14 valid requests and two crews over an eleven-hour day', () => {
  const input = buildLiveDemo('2026-09-19', datasetRoot);
  assert.equal(uploadDataPackageSchema.safeParse(input).success, true);
  assert.equal(input.requests.length, 14);
  assert.equal(input.engineers?.length, 2);
  const firstEngineer = input.engineers?.[0];
  assert.ok(firstEngineer);
  assert.equal(firstEngineer.shiftEndAt - firstEngineer.shiftStartAt, 11 * 3600);
  assert.equal(
    new Date(firstEngineer.shiftStartAt * 1000).toISOString(),
    '2026-09-19T06:00:00.000Z',
  );
  assert.equal(new Set(input.requests.map((request) => request.externalId)).size, 14);
  const second = buildLiveDemo('2026-09-19', datasetRoot);
  assert.deepEqual(input, second);
});

test('LIVE fixture rejects invalid dates rather than silently rolling the day', () => {
  assert.throws(() => buildLiveDemo('2026-02-30', datasetRoot));
  assert.throws(() => buildLiveDemo('not-a-date', datasetRoot));
});
