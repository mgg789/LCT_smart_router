import { describe, expect, it } from 'vitest';
import type { EngineerLiveView } from '../api/live';
import { shouldEnterLiveLine } from './liveSession';

function liveView(
  status: EngineerLiveView['workday']['status'],
  lineStatus: EngineerLiveView['engineer']['lineStatus'],
): EngineerLiveView {
  return {
    workday: {
      id: 'day-1',
      workDate: '2026-09-20',
      status,
      logicalStartAt: 1,
      logicalEndAt: 2,
      startedAtWallSec: status === 'running' ? 1 : null,
      finishedAt: null,
      completionReason: null,
      liveNow: 1,
      speedDurationSec: 3600,
      speedFactor: 10,
      engineerStartDeadlineAt: 1,
      requestCount: 0,
      stats: {
        completedCount: 0,
        cancelledCount: 0,
        assumedCompletedCount: 0,
        problemCount: 0,
        technicalBreakCount: 0,
      },
    },
    engineer: {
      id: 'engineer-1',
      name: 'Engineer',
      lineStatus,
      availability: 'online',
      activeRequestId: null,
      technicalBreak: null,
      progress: null,
      routeState: 'awaiting_plan',
      canFinishDay: false,
      stats: {
        completedCount: 0,
        cancelledCount: 0,
        assumedCompletedCount: 0,
        problemCount: 0,
        technicalBreakCount: 0,
      },
      pendingDelayProblem: null,
    },
    current: null,
    lunch: null,
    route: null,
  };
}

describe('engineer LIVE session', () => {
  it('enters the line only for a signed-in pending or no-show engineer on a running day', () => {
    expect(shouldEnterLiveLine(liveView('running', 'pending'))).toBe(true);
    expect(shouldEnterLiveLine(liveView('running', 'no_show_offline'))).toBe(true);
    expect(shouldEnterLiveLine(liveView('running', 'technical_break'))).toBe(false);
    expect(shouldEnterLiveLine(liveView('pending', 'pending'))).toBe(false);
  });
});
