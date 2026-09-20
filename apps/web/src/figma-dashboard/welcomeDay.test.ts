import { describe, expect, it } from 'vitest';
import {
  clearWorkDayStarted,
  hasStartedWorkDay,
  markWorkDayStarted,
  moscowClockLabel,
  moscowWorkDate,
  shouldShowStartWelcome,
  WORKDAY_STARTED_KEY,
} from './welcomeDay';

describe('welcomeDay', () => {
  it('formats the Moscow civil date as YYYY-MM-DD', () => {
    expect(moscowWorkDate(Date.UTC(2026, 8, 19, 6, 0, 0))).toBe('2026-09-19');
  });

  it('formats the Moscow clock', () => {
    expect(moscowClockLabel(Date.UTC(2026, 8, 19, 6, 8, 0))).toBe('09:08');
  });

  it('starts the work day once per stored date', () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    };
    expect(hasStartedWorkDay(storage, '2026-09-19')).toBe(false);
    markWorkDayStarted(storage, '2026-09-19');
    expect(memory.get(WORKDAY_STARTED_KEY)).toBe('2026-09-19');
    expect(hasStartedWorkDay(storage, '2026-09-19')).toBe(true);
    expect(hasStartedWorkDay(storage, '2026-09-20')).toBe(false);
    clearWorkDayStarted(storage);
    expect(hasStartedWorkDay(storage, '2026-09-19')).toBe(false);
  });

  it('does not send a running LIVE day back to Welcome after a cached refresh', () => {
    expect(
      shouldShowStartWelcome({
        source: 'cached',
        liveStatus: 'running',
        welcomeOpen: true,
        hasSnapshot: true,
      }),
    ).toBe(false);
    expect(
      shouldShowStartWelcome({
        source: 'live',
        liveStatus: 'pending',
        welcomeOpen: false,
        hasSnapshot: true,
      }),
    ).toBe(true);
    expect(
      shouldShowStartWelcome({
        source: 'demo',
        liveStatus: null,
        welcomeOpen: true,
        hasSnapshot: true,
      }),
    ).toBe(true);
  });
});
