import { describe, expect, it } from 'vitest';
import { formatWindowCountdown } from './format';
import { formatLiveCountdown, liveNowAt, moscowTimeInputAt } from './live';

describe('live clock helpers', () => {
  it('interpolates accelerated logical time from an API anchor', () => {
    expect(liveNowAt({ liveNow: 1_000, speedFactor: 12, receivedAtMs: 500 }, 1_750)).toBe(1_015);
  });

  it('formats short countdowns and parses Moscow time input', () => {
    expect(formatLiveCountdown(61.1)).toBe('01:02');
    expect(moscowTimeInputAt('2026-09-19', '09:00')).toBe(1_789_797_600);
  });

  it('uses the authoritative logical clock for request-window countdowns', () => {
    const nowAt = liveNowAt({ liveNow: 9 * 3600 + 10 * 60, speedFactor: 12, receivedAtMs: 0 }, 0);
    expect(formatWindowCountdown(nowAt, 9 * 3600, 10 * 3600)).toBe('до конца окна 50 мин');
  });
});
