import { describe, expect, it } from 'vitest';
import type { LiveWorkday } from '../api/live';
import { businessAt } from './liveClock';

function day(overrides: Partial<LiveWorkday> = {}): LiveWorkday {
  return {
    id: 'w-1',
    status: 'running',
    workDate: '2026-09-28',
    logicalStartAt: 1_790_575_200,
    logicalEndAt: 1_790_614_800,
    startedAtWallSec: 1_790_600_000,
    finishedAt: null,
    completionReason: null,
    liveNow: 1_790_575_200,
    speedDurationSec: 1_800,
    speedFactor: 22,
    engineerStartDeadlineAt: 1_790_575_200,
    requestCount: 14,
    stats: {
      completedCount: 0,
      cancelledCount: 0,
      assumedCompletedCount: 0,
      problemCount: 0,
    } as LiveWorkday['stats'],
    ...overrides,
  };
}

describe('businessAt', () => {
  it('tells a stamp from a running day on the clock the day is run by', () => {
    // One real minute in, at 22×, is 22 business minutes past the 09:00 opening.
    expect(businessAt(1_790_600_060, day())).toBe(1_790_575_200 + 60 * 22);
  });

  it('leaves the stamp alone when no day is running', () => {
    expect(businessAt(1_790_600_060, null)).toBe(1_790_600_060);
    expect(businessAt(1_790_600_060, day({ status: 'pending' }))).toBe(1_790_600_060);
    expect(businessAt(1_790_600_060, day({ startedAtWallSec: null }))).toBe(1_790_600_060);
  });

  it('puts anything written before the day started at its opening moment', () => {
    expect(businessAt(1_790_599_000, day())).toBe(1_790_575_200);
  });
});
