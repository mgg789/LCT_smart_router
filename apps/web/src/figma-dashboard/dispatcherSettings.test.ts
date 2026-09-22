import { describe, expect, it } from 'vitest';
import {
  clampLatenessMin,
  clockFromMinutes,
  DEFAULT_DISPATCHER_SETTINGS,
  DISPATCHER_SETTINGS_KEY,
  latenessMinFromSec,
  minutesFromClock,
  readDispatcherSettings,
  validateDispatcherSettings,
  writeDispatcherSettings,
} from './dispatcherSettings';

describe('dispatcherSettings', () => {
  it('converts Moscow minutes to HH:MM and back', () => {
    expect(clockFromMinutes(9 * 60 + 30)).toBe('09:30');
    expect(minutesFromClock('21:00')).toBe(21 * 60);
  });

  it('clamps lateness to 0–15 minutes', () => {
    expect(clampLatenessMin(-3)).toBe(0);
    expect(clampLatenessMin(7.4)).toBe(7);
    expect(clampLatenessMin(20)).toBe(15);
    expect(latenessMinFromSec(600)).toBe(10);
  });

  it('rejects an inverted shift and an out-of-range lateness', () => {
    expect(
      validateDispatcherSettings({ ...DEFAULT_DISPATCHER_SETTINGS, shiftEnd: '08:00' }),
    ).toBeTruthy();
    expect(
      validateDispatcherSettings({ ...DEFAULT_DISPATCHER_SETTINGS, latenessMin: 16 }),
    ).toBeTruthy();
    expect(
      validateDispatcherSettings({ ...DEFAULT_DISPATCHER_SETTINGS, latenessMin: 5 }),
    ).toBeNull();
  });

  it('round-trips settings through storage', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
    };
    const saved = {
      shiftStart: '08:30',
      shiftEnd: '17:45',
      latenessMin: 10,
      mapProvider: 'yandex' as const,
      mapToken: 'test-token',
    };
    writeDispatcherSettings(storage, saved);
    expect(memory.get(DISPATCHER_SETTINGS_KEY)).toContain('yandex');
    expect(readDispatcherSettings(storage)).toEqual(saved);
  });
});
