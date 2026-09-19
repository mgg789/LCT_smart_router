import { describe, expect, it } from 'vitest';
import { liveProgressPoints, liveProgressSegments } from './DayMap';

describe('LIVE map factual projection', () => {
  const anchor = { kind: 'job' as const, requestId: 'done', lat: 55.75, lon: 37.61, at: 100 };
  const next = { kind: 'job' as const, requestId: 'next', lat: 55.76, lon: 37.62, at: 200 };

  it('retains the finished anchor and highlights its outgoing edge while traveling', () => {
    const progress = { phase: 'traveling' as const, anchor, lunch: null, next, occurredAt: 110 };
    expect(liveProgressSegments(progress)).toEqual([{ from: anchor, to: next }]);
    expect(liveProgressPoints(progress)).toEqual([anchor]);
  });

  it('projects lunch as both legs and the lunch vertex at once', () => {
    const lunch = { kind: 'lunch' as const, requestId: null, lat: 55.755, lon: 37.615, at: 150 };
    const progress = { phase: 'lunch' as const, anchor, lunch, next, occurredAt: 150 };
    expect(liveProgressSegments(progress)).toEqual([
      { from: anchor, to: lunch },
      { from: lunch, to: next },
    ]);
    expect(liveProgressPoints(progress)).toEqual([anchor, lunch]);
  });

  it('marks the current vertex without retaining a past connector after next job starts', () => {
    const progress = {
      phase: 'on_site' as const,
      anchor: next,
      lunch: null,
      next: null,
      occurredAt: 200,
    };
    expect(liveProgressSegments(progress)).toEqual([]);
    expect(liveProgressPoints(progress)).toEqual([next]);
  });
});
