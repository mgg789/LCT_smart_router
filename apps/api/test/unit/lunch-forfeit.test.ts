import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forfeitsLunchOnLateEntry } from '../../src/orchestrator/live/lunch-forfeit';

const start = 1_700_000_000;
const end = start + 3 * 3600;

describe('late line entry during lunch', () => {
  it('spends the lunch only inside an enabled window', () => {
    const base = {
      enabled: true,
      taken: false,
      windowStartAt: start,
      windowEndAt: end,
    };
    assert.equal(forfeitsLunchOnLateEntry({ ...base, liveNow: start }), true);
    assert.equal(forfeitsLunchOnLateEntry({ ...base, liveNow: end - 1 }), true);
    assert.equal(forfeitsLunchOnLateEntry({ ...base, liveNow: start - 1 }), false);
    assert.equal(forfeitsLunchOnLateEntry({ ...base, liveNow: end }), false);
    assert.equal(forfeitsLunchOnLateEntry({ ...base, liveNow: start, taken: true }), false);
    assert.equal(forfeitsLunchOnLateEntry({ ...base, liveNow: start, enabled: false }), false);
    assert.equal(
      forfeitsLunchOnLateEntry({ ...base, liveNow: start, windowStartAt: null }),
      false,
    );
  });
});
