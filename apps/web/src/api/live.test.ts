import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDispatchLive } from './live';

afterEach(() => vi.unstubAllGlobals());

describe('dispatcher live client', () => {
  it('keeps inferred completion separate from a confirmed history entry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          workday: {
            id: 'day-1',
            status: 'running',
            workDate: '2026-09-19',
            logicalStartAt: 1_790_000_000,
            logicalEndAt: 1_790_036_000,
            startedAtWallSec: 1_790_000_000,
            finishedAt: null,
            completionReason: null,
            liveNow: 1_790_001_800,
            speedDurationSec: 3_600,
            speedFactor: 10,
            engineerStartDeadlineAt: 1_790_001_800,
            requestCount: 2,
            stats: stats,
          },
          engineers: [engineer],
          history: [
            {
              request: { ...request, assumedCompletedAt: 1_790_001_200 },
              engineerId: 'engineer-1',
              stop: null,
              outcome: 'assumed_completed',
              terminalAt: 1_790_001_200,
            },
          ],
        }),
      ),
    );

    const live = await loadDispatchLive('session-token');

    expect(live.history[0]).toMatchObject({
      engineerId: 'engineer-1',
      outcome: 'assumed_completed',
      request: { assumedCompletedAt: 1_790_001_200, completedAt: null },
    });
  });
});

const engineer = {
  id: 'engineer-1',
  name: 'Alex Engineer',
  lineStatus: 'online',
  availability: 'online',
  activeRequestId: null,
  routeState: 'active',
  progress: null,
  stats: {
    completedCount: 0,
    cancelledCount: 0,
    assumedCompletedCount: 0,
    problemCount: 0,
    technicalBreakCount: 0,
  },
  technicalBreak: null,
  pendingDelayProblem: null,
} as const;

const stats = {
  completedCount: 0,
  cancelledCount: 0,
  assumedCompletedCount: 0,
  problemCount: 0,
  technicalBreakCount: 0,
} as const;

const request = {
  id: 'request-1',
  version: 1,
  lifecycle: 'submitted',
  assignmentState: 'assigned',
  addressText: 'Moscow',
  region: 'east',
  lat: 55.75,
  lon: 37.61,
  needsGeocoding: false,
  geocodeQuality: 'exact',
  requiredEquipment: null,
  workType: 'office',
  workTypeTitle: 'Office connection',
  requiredSkill: 'office',
  normProfileCode: 'connection',
  normativeTravelDurationSec: 1_200,
  technicalDurationSec: 3_000,
  documentationDurationSec: 600,
  serviceDurationSec: 3_600,
  actualDurationSec: null,
  durationVarianceSec: null,
  windowStartAt: 1_790_000_000,
  windowEndAt: 1_790_003_600,
  priority: 'normal',
  contactName: null,
  problemText: null,
  createdAt: 1_789_990_000,
  submittedAt: 1_789_990_100,
  startedAt: null,
  expectedCompletionAt: null,
  continuationAvailableAt: null,
  overrunDetectedAt: null,
  assumedStartedAt: null,
  assumedCompletedAt: null,
  completedAt: null,
  cancelledAt: null,
} as const;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
