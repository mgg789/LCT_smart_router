import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardApiError,
  loadDashboardSnapshot,
  loadPolicyComparison,
  selectRoutingPolicy,
  setEngineerAvailability,
  setLunchesEnabled,
  uploadDataPackage,
} from './client';

describe('request failure metadata', () => {
  it('bounds a stalled request without replaying it', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    try {
      const request = selectRoutingPolicy('test-session', 'compact');
      const assertion = expect(request).rejects.toMatchObject({
        status: 0,
        path: '/api/v1/dispatch/policy',
      });
      await vi.advanceTimersByTimeAsync(12_000);
      await assertion;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('allows cold comparisons past the ordinary timeout but still bounds stalled work', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }),
    );
    try {
      const request = loadPolicyComparison('test-session');
      const assertion = expect(request).rejects.toMatchObject({ status: 0 });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(78_000);
      await assertion;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('preserves status and trace ID for an HTTP failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'unavailable' }), {
          status: 503,
          headers: { 'x-request-id': 'trace-qa' },
        }),
      ),
    );
    await expect(selectRoutingPolicy('test-session', 'compact')).rejects.toMatchObject({
      name: 'DashboardApiError',
      status: 503,
      requestId: 'trace-qa',
      path: '/api/v1/dispatch/policy',
    });
    expect(new DashboardApiError('test', 401).status).toBe(401);
  });
});

const request = {
  id: 'request-1',
  version: 1,
  lifecycle: 'submitted',
  assignmentState: 'assigned',
  addressText: 'Moscow',
  lat: 55.75,
  lon: 37.61,
  needsGeocoding: false,
  geocodeQuality: 'exact',
  requiredEquipment: 'router',
  workType: 'office',
  workTypeTitle: 'Office connection',
  requiredSkill: 'office',
  normProfileCode: 'connection',
  normativeTravelDurationSec: 1200,
  technicalDurationSec: 3000,
  documentationDurationSec: 600,
  serviceDurationSec: 3600,
  actualDurationSec: null,
  durationVarianceSec: null,
  windowStartAt: 1_800_000_000,
  windowEndAt: 1_800_003_600,
  priority: 'normal',
  contactName: null,
  problemText: null,
  createdAt: 1_799_990_000,
  submittedAt: 1_799_990_100,
  startedAt: null,
  expectedCompletionAt: null,
  continuationAvailableAt: null,
  overrunDetectedAt: null,
  completedAt: null,
  cancelledAt: null,
} as const;

const engineer = {
  id: 'engineer-1',
  version: 1,
  displayName: 'Alex Engineer',
  inputOrder: 1,
  skills: ['office'],
  transportType: 'car',
  region: 'east',
  homeLat: 55.74,
  homeLon: 37.6,
  hasAccount: false,
  email: null,
  day: {
    engineerId: 'engineer-1',
    workDate: '2026-09-17',
    version: 1,
    shiftStartAt: 1_800_000_000,
    shiftEndAt: 1_800_028_800,
    availability: 'online',
    expectedOnlineAt: null,
    equipmentStock: { router: 3, setTopBox: 2, smartSpeaker: 1 },
    equipmentIssuedAt: 1_799_999_100,
    lunch: {
      enabled: false,
      durationSec: null,
      windowStartAt: null,
      windowEndAt: null,
      required: false,
      taken: false,
      startedAt: null,
    },
  },
} as const;

const settings = {
  lunchesEnabled: false,
  departureLatenessToleranceSec: 0,
  taskStartLatenessToleranceSec: 0,
  travelTimeMode: 'graph_with_access_buffer',
  accessBufferSec: 600,
  fixedTravelTimeSec: 1200,
  earlyFinishReplanThresholdSec: 900,
  taskOverrunToleranceSec: 600,
  routerContextVersion: 'context-1',
} as const;

afterEach(() => vi.unstubAllGlobals());

describe('live dashboard client', () => {
  it('aggregates backend resources and normalizes structured reasons', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), 'http://local').pathname;
        if (path.endsWith('/requests')) return json({ requests: [request] });
        if (path.endsWith('/engineers')) return json({ engineers: [engineer] });
        if (path.endsWith('/plan')) {
          return json({
            mode: 'auto',
            modeVersion: 1,
            plan: {
              revision: 7,
              origin: 'auto',
              planAsOf: 1_800_000_000,
              appliedAt: 1_800_000_100,
              routes: [],
              assignments: [
                {
                  requestId: 'request-1',
                  status: 'assigned',
                  engineerId: 'engineer-1',
                  reasons: [
                    {
                      code: 'CONSTRAINTS_SATISFIED',
                      text: 'Constraints verified.',
                      basis: 'constraint_check',
                      facts: { skill: 'office' },
                    },
                  ],
                },
              ],
            },
            appliedResult: null,
            lastResult: null,
          });
        }
        if (path.endsWith('/alerts'))
          return json({
            alerts: [
              {
                id: 'risk',
                code: 'time_risk',
                kind: 'alert',
                severity: 'warning',
                engineerIds: ['engineer-1'],
                requestIds: ['request-1'],
                reasons: [{ plannedStartAt: 1_800_000_600, windowEndAt: 1_800_000_000 }],
                restoreOption: { engineer_id: 'engineer-1', reject_request_ids: ['request-1'] },
                actions: ['move_window'],
                createdAt: 1_800_000_000,
                seenAt: null,
                resolvedAt: null,
              },
            ],
          });
        if (path.endsWith('/shift'))
          return json({ workDate: '2026-09-17', closedAt: null, unresolvedCount: 0 });
        if (path.endsWith('/policies')) {
          return json({
            policies: [
              {
                policyId: 'compact',
                title: 'Compact',
                description: 'Use fewer engineers',
                isDefault: true,
              },
            ],
            active: { policyId: 'compact', version: 1, changedAt: 1_800_000_000 },
          });
        }
        if (path.endsWith('/router/technical-settings')) return json(settings);
        throw new Error(`Unexpected request: ${path}`);
      }),
    );

    const snapshot = await loadDashboardSnapshot('session-token');

    expect(snapshot.workDate).toBe('2026-09-17');
    expect(snapshot.policyId).toBe('compact');
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.alerts[0]?.reasons[0]).toContain('Опоздание: 10 мин.');
    expect(snapshot.alerts[0]?.restoreOption).toEqual({
      engineer_id: 'engineer-1',
      reject_request_ids: ['request-1'],
    });
    expect(snapshot.plan.plan?.assignments[0]?.reasons.assignment?.factors[0]).toMatchObject({
      code: 'CONSTRAINTS_SATISFIED',
      detail: 'Constraints verified.',
      basis: 'constraint_check',
      facts: { skill: 'office' },
    });
  });

  it('preserves all technical settings when toggling lunches', async () => {
    let sentBody: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET') return json(settings);
        sentBody = JSON.parse(String(init?.body));
        return json({
          ...settings,
          ...((sentBody ?? {}) as object),
          routerContextVersion: 'context-2',
          status: 'accepted',
        });
      }),
    );

    const contextVersion = await setLunchesEnabled('session-token', true);

    expect(sentBody).toMatchObject({
      expectedContextVersion: 'context-1',
      lunchesEnabled: true,
      travelTimeMode: 'graph_with_access_buffer',
      accessBufferSec: 600,
      taskOverrunToleranceSec: 600,
      windowLatenessToleranceSec: 0,
      trafficEnabled: true,
      equipmentEnabled: true,
    });
    expect(contextVersion).toBe('context-2');
  });

  it('returns the exact publication hash created by a policy selection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          policyId: 'fast',
          publication: {
            published: true,
            inputHash: 'published-input-hash',
            planningAsOf: 1_800_000_100,
            snapshotId: 'snapshot-1',
          },
        }),
      ),
    );

    await expect(selectRoutingPolicy('session-token', 'fast')).resolves.toBe(
      'published-input-hash',
    );
  });

  it.each([false, true])(
    'loads legacy and expanded comparisons (covering=%s)',
    async (expanded) => {
      const strategies = expanded
        ? (['fast', 'compact', 'sla', 'balanced', 'eco', 'covering', 'baseline'] as const)
        : (['fast', 'compact', 'sla', 'balanced', 'eco', 'baseline'] as const);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          json({
            inputPublicationId: 'publication-1',
            inputHash: 'input-1',
            routerContextVersion: 'context-1',
            computedAt: 1_800_000_200,
            searchBudgetMs: 2_000,
            rows: strategies.map((strategyId) => ({
              strategyId,
              kind: strategyId === 'baseline' ? 'baseline' : 'policy',
              additionalEngineers: strategyId === 'covering' ? 2 : 0,
              isUsable: true,
              calculationMs: 12,
              metrics: {
                requestsTotal: 5,
                assignedCount: 4,
                unassignedCount: 1,
                urgentTotal: 1,
                urgentAssignedCount: 1,
                engineersUsed: 2,
                distanceKm: 14.5,
                travelTimeSec: 2_400,
                workTimeSec: 10_800,
                waitingTimeSec: 600,
                lunchTimeSec: 0,
                minWindowSlackSec: -600,
              },
            })),
          }),
        ),
      );

      const comparison = await loadPolicyComparison('session-token');
      expect(comparison.inputPublicationId).toBe('publication-1');
      expect(comparison.rows[0]?.metrics.minWindowSlackSec).toBe(-600);
      expect(comparison.rows.map((row) => row.strategyId)).toEqual(strategies);
      if (expanded)
        expect(
          comparison.rows.find((row) => row.strategyId === 'covering')?.additionalEngineers,
        ).toBe(2);
    },
  );

  it('publishes an engineer availability change for exact rebuild correlation', async () => {
    let sentBody: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return json({ publication: { inputHash: 'availability-input' } });
      }),
    );

    const inputHash = await setEngineerAvailability('session-token', 'engineer/1', 'offline');
    expect(sentBody).toMatchObject({ availability: 'offline', expectedOnlineAt: null });
    expect(inputHash).toBe('availability-input');
  });

  it('adds an idempotency key to a locally validated data package', async () => {
    let sentBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({
          applied: true,
          region: 'east',
          mode: 'append_requests',
          requestsCreated: 1,
          engineersCreated: 0,
          depotsCreated: 0,
          warnings: [],
          publicationId: 'publication-2',
          inputHash: 'input-2',
        });
      }),
    );

    await uploadDataPackage('session-token', {
      schemaVersion: '1.0',
      mode: 'append_requests',
      region: 'east',
      sourceVersion: '2',
      requests: [
        {
          externalId: 'request-2',
          addressText: 'Moscow',
          lat: 55.75,
          lon: 37.61,
          serviceDurationSec: 3600,
          windowStartAt: 1_800_000_000,
          windowEndAt: 1_800_003_600,
          priority: 'normal',
          requiredSkill: 'connection',
        },
      ],
    });

    expect(sentBody).toMatchObject({
      operationId: expect.any(String),
      schemaVersion: '1.0',
      mode: 'append_requests',
    });
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
