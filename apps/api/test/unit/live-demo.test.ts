import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { uploadDataPackageSchema } from '../../src/api/dto/data.dto';
import {
  buildLiveDemo,
  LEGACY_LIVE_DEMO_PACKAGE_PREFIX,
  LIVE_DEMO_PACKAGE_PREFIX,
  LIVE_DEMO_PACKAGE_PREFIXES,
  liveDemoPackageSource,
} from '../../src/orchestrator/demo-stand/live-demo-package';

const datasetRoot = resolve(__dirname, '../../../../..', 'data/dataset/anonymized');

test('LIVE fixture supplies 14 valid requests and three crews over an eleven-hour day', () => {
  const input = buildLiveDemo('2026-09-19', datasetRoot);
  assert.equal(uploadDataPackageSchema.safeParse(input).success, true);
  assert.equal(input.requests.length, 14);
  assert.equal(input.engineers?.length, 3);
  const firstEngineer = input.engineers?.[0];
  assert.ok(firstEngineer);
  assert.equal(firstEngineer.shiftEndAt - firstEngineer.shiftStartAt, 11 * 3600);
  assert.equal(
    new Date(firstEngineer.shiftStartAt * 1000).toISOString(),
    '2026-09-19T06:00:00.000Z',
  );
  assert.equal(new Set(input.requests.map((request) => request.externalId)).size, 14);
  const firstRequest = input.requests[0];
  const secondRequest = input.requests[1];
  assert.ok(firstRequest);
  assert.ok(secondRequest);
  const walkingEngineer = input.engineers?.[2];
  assert.ok(walkingEngineer);
  assert.equal(walkingEngineer.transportType, 'walk');
  // A shift start on a request pin gives that visit a zero-length leg with nothing to draw.
  assert.ok(walkingEngineer.start);
  const { lat, lon } = walkingEngineer.start;
  assert.ok(input.requests.every((request) => request.lat !== lat || request.lon !== lon));
  assert.deepEqual(
    input.requests.slice(0, 2).map((request) => request.requiredTransport),
    ['walk', 'walk'],
  );
  assert.equal(secondRequest.windowStartAt - firstRequest.windowStartAt, 75 * 60);
  assert.ok(input.requests.slice(2).every((request) => request.requiredTransport === undefined));
  assert.equal(firstEngineer.equipmentStock?.router, 2);
  assert.equal(firstEngineer.equipmentStock?.setTopBox, 1);
  assert.equal(input.engineers?.[1]?.equipmentStock?.router, 0);
  assert.deepEqual(
    input.requests
      .filter((request) => request.requiredEquipment === 'router')
      .map((request) => request.externalId),
    ['live-request-04', 'live-request-05'],
  );
  assert.equal(
    input.requests.find((request) => request.requiredEquipment === 'set_top_box')?.externalId,
    'live-request-06',
  );
  assert.equal(input.sourceVersion, 'live-demo-v2-2026-09-19');
  assert.equal(liveDemoPackageSource('2026-09-19'), `${LIVE_DEMO_PACKAGE_PREFIX}2026-09-19`);
  assert.deepEqual(LIVE_DEMO_PACKAGE_PREFIXES, [
    LIVE_DEMO_PACKAGE_PREFIX,
    LEGACY_LIVE_DEMO_PACKAGE_PREFIX,
  ]);
  const second = buildLiveDemo('2026-09-19', datasetRoot);
  assert.deepEqual(input, second);
});

test('LIVE fixture rejects invalid dates rather than silently rolling the day', () => {
  assert.throws(() => buildLiveDemo('2026-02-30', datasetRoot));
  assert.throws(() => buildLiveDemo('not-a-date', datasetRoot));
});
