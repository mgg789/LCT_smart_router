import { describe, expect, it } from 'vitest';
import type { LiveRouteProgress } from '../api/live';
import { routeProgressMarker } from './routeProgress';

describe('Figma route LIVE cursor', () => {
  const progress: LiveRouteProgress = {
    phase: 'traveling',
    origin: { kind: 'start', requestId: null, lat: 0, lon: 0, at: 0 },
    anchor: { kind: 'start', requestId: null, lat: 0, lon: 0, at: 0 },
    lunch: null,
    next: { kind: 'job', requestId: 'r1', lat: 1, lon: 1, at: 100 },
    occurredAt: 25,
  };

  it('places the marker proportionally on the visible travel edge', () => {
    expect(
      routeProgressMarker(
        [
          { time: '08:00', place: 'Старт', status: '', kind: 'start', at: 0 },
          { time: '08:10', place: 'Клиент', status: '', kind: 'job', requestId: 'r1', at: 100 },
        ],
        progress,
      ),
    ).toEqual({ fromIndex: 0, toIndex: 1, progress: 0.25 });
  });

  it('does not invent a marker outside travel', () => {
    expect(routeProgressMarker([], { ...progress, phase: 'on_site' })).toBeNull();
  });
});
