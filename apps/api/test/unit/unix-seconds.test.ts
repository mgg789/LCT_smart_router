import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatUnixSeconds,
  fromUnixSeconds,
  isUnixSeconds,
  toUnixSeconds,
} from '../../src/common/time/unix-seconds';

describe('unix seconds', () => {
  it('round-trips whole seconds', () => {
    const seconds = 1789459200;
    assert.equal(toUnixSeconds(fromUnixSeconds(seconds)), seconds);
  });

  it('truncates sub-second precision instead of rounding up', () => {
    assert.equal(toUnixSeconds(new Date(1789459200_999)), 1789459200);
  });

  it('rejects milliseconds-sized and fractional values as not unix seconds', () => {
    assert.equal(isUnixSeconds(1789459200), true);
    assert.equal(isUnixSeconds(1.5), false);
    assert.equal(isUnixSeconds('1789459200'), false);
  });

  it('renders the same instant differently per zone without changing it', () => {
    const seconds = 1789459200;
    const moscow = formatUnixSeconds(seconds, 'Europe/Moscow');
    const utc = formatUnixSeconds(seconds, 'UTC');
    assert.notEqual(moscow, utc);
    assert.equal(toUnixSeconds(fromUnixSeconds(seconds)), seconds);
  });
});
