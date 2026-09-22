import assert from 'node:assert/strict';
import { it } from 'node:test';
import { etaNeedsReplan, finishNeedsReplan } from '../../src/orchestrator/live/replan-policy';

it('does not replan baseline finishes or early finishes with at most thirty minutes of slack', () => {
  assert.equal(finishNeedsReplan(1900, 0, 1800, 600, 3700), false);
  assert.equal(finishNeedsReplan(1900, 0, 1800, 600, 3701), true);
  assert.equal(finishNeedsReplan(2400, 0, 1800, 600, 6000), false);
  assert.equal(finishNeedsReplan(2401, 0, 1800, 600, null), true);
  assert.equal(finishNeedsReplan(1500, 0, 1800, 600, null), false);
});
it('uses a strict twenty-five minute forecast threshold for both arrival and completion', () => {
  assert.equal(etaNeedsReplan(1500, 0, 1800, 4000), false);
  assert.equal(etaNeedsReplan(1501, 0, 1800, 4000), true);
  assert.equal(etaNeedsReplan(1000, 1000, 1800, 1300), false);
  assert.equal(etaNeedsReplan(1000, 1000, 1800, 1299), true);
});
