import { describe, expect, it } from 'vitest';
import type { LiveEngineerState } from '../model/types';
import { crewTally } from './crewTally';

function crew(over: Partial<LiveEngineerState> = {}): LiveEngineerState {
  return {
    id: 'e1',
    name: 'Бригада Соколов',
    lineStatus: 'online',
    lineStartedAt: 1,
    activeRequestId: null,
    routeState: 'active',
    stats: {
      completedCount: 2,
      cancelledCount: 0,
      assumedCompletedCount: 0,
      problemCount: 0,
      technicalBreakCount: 0,
    },
    ...over,
  };
}

describe('crewTally', () => {
  it('counts what is behind the crew against its whole day', () => {
    expect(crewTally(crew(), ['r3', 'r4', 'r5', 'r6'])).toEqual({ done: 2, total: 6 });
  });

  it('counts a visit the schedule carried past as done', () => {
    const state = crew({
      stats: { ...crew().stats, completedCount: 1, assumedCompletedCount: 1 },
    });
    expect(crewTally(state, ['r3'])).toEqual({ done: 2, total: 3 });
  });

  it('adds the started visit once a replan has taken it out of the route', () => {
    expect(crewTally(crew({ activeRequestId: 'r9' }), ['r3'])).toEqual({ done: 2, total: 4 });
  });

  it('does not count the started visit twice while it is still in the route', () => {
    expect(crewTally(crew({ activeRequestId: 'r3' }), ['r3', 'r4'])).toEqual({ done: 2, total: 4 });
  });

  it('says nothing for a crew the LIVE day does not know', () => {
    expect(crewTally(undefined, ['r1'])).toBeNull();
  });
});
