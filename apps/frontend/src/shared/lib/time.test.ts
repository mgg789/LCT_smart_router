import { describe, expect, it } from 'vitest';
import { formatDayTitle, formatKm, formatMinutes, formatRange, formatTime } from './time';

// 2026-09-19 09:10 Moscow == 06:10 UTC
const NINE_TEN_MSK = Date.UTC(2026, 8, 19, 6, 10) / 1000;
const TWELVE_MSK = Date.UTC(2026, 8, 19, 9, 0) / 1000;

describe('time rendering', () => {
  it('prints Moscow time regardless of the machine zone', () => {
    expect(formatTime(NINE_TEN_MSK)).toBe('09:10');
  });

  it('prints the day heading the way the mockup does', () => {
    expect(formatDayTitle(NINE_TEN_MSK)).toBe('19 сентября, 2026');
  });

  it('prints a window as a range', () => {
    expect(formatRange(NINE_TEN_MSK, TWELVE_MSK)).toBe('09:10-12:00');
  });

  it('rounds durations to whole minutes', () => {
    expect(formatMinutes(2700)).toBe('45 мин');
    expect(formatMinutes(719)).toBe('12 мин');
  });

  it('prints distance without false precision', () => {
    expect(formatKm(28.4)).toBe('28 км');
  });
});
