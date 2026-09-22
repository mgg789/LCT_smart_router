import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildMapsDemo } from '../../scripts/maps-demo';

it('builds a four-job single-car microset on the requested Moscow date', () => {
  const demo = buildMapsDemo('2026-09-24');
  assert.equal(demo.requests.length, 4);
  assert.equal(demo.engineers?.length, 1);
  assert.equal(demo.engineers?.[0]?.transportType, 'car');
  assert.equal(demo.engineers?.[0]?.shiftStartAt, Date.parse('2026-09-24T09:00:00+03:00') / 1000);
  assert.ok(demo.requests.every((request) => request.serviceDurationSec > 0));
});
