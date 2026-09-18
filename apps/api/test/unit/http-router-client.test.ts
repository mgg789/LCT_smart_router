import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { HttpRouterClient } from '../../src/routing/router-gateway/http-router-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('HttpRouterClient', () => {
  it('maps a cold policy comparison with a timeout longer than ordinary Router calls', async () => {
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), 'http://router:8100/v1/policy-comparison');
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(init?.signal?.aborted, false);
      return Response.json({
        input_publication_id: 'publication-1',
        input_hash: 'a'.repeat(64),
        router_context_version: 'context-1',
        computed_at: 1_800_000_000,
        search_budget_ms: 2_000,
        rows: [
          {
            strategy_id: 'covering',
            kind: 'policy',
            additional_engineers: 2,
            is_usable: true,
            calculation_ms: 4,
            summary: {
              requests_total: 5,
              assigned_count: 4,
              unassigned_count: 1,
              urgent_total: 1,
              urgent_assigned_count: 1,
              engineers_used: 2,
              distance_km: 12.5,
              travel_time_sec: 1800,
              work_time_sec: 7200,
              waiting_time_sec: 300,
              lunch_time_sec: 0,
            },
          },
        ],
      });
    };
    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100',
      requestTimeoutMs: 10,
    });

    const comparison = await client.getPolicyComparison();
    assert.equal(comparison.rows[0]?.strategyId, 'covering');
    assert.equal(comparison.rows[0]?.additionalEngineers, 2);
    assert.equal(comparison.rows[0]?.metrics.assignedCount, 4);
    assert.equal(comparison.inputHash, 'a'.repeat(64));
  });

  it('reads and validates Router result and active context', async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      if (String(input).endsWith('/v1/context')) {
        return Response.json({ router_context_version: 'ctx-7', status: 'ready' });
      }
      return Response.json({
        schema_version: '1.0',
        status: 'pending',
        result_id: null,
        input_publication_id: null,
        input_hash: null,
        planning_as_of: null,
        computed_at: null,
        router_context_version: 'ctx-7',
        main: null,
        baseline: null,
        errors: [],
      });
    };

    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100/',
      requestTimeoutMs: 1_000,
    });

    assert.equal((await client.getResult()).status, 'pending');
    assert.equal(await client.getActiveContextVersion(), 'ctx-7');
    assert.deepEqual(calls, ['http://router:8100/v1/result', 'http://router:8100/v1/context']);
    assert.equal(client.isConfigured(), true);
  });

  it('rejects malformed responses before they reach acceptance', async () => {
    globalThis.fetch = async () => Response.json({ status: 'ready' });
    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100',
      requestTimeoutMs: 1_000,
    });

    await assert.rejects(() => client.getResult(), /response is invalid/);
  });

  it('reads and replaces complete technical settings with Router CAS fields', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      if (!init?.method) {
        return Response.json({
          router_context_version: 'ctx-old',
          technical_settings: {
            lunches_enabled: false,
            departure_lateness_tolerance_sec: 60,
            task_start_lateness_tolerance_sec: 120,
            travel_time_mode: 'graph_with_access_buffer',
            access_buffer_sec: 600,
            fixed_travel_time_sec: 1200,
            early_finish_replan_threshold_sec: 900,
            task_overrun_tolerance_sec: 600,
          },
        });
      }
      return Response.json({
        operation_id: 'op-1',
        status: 'accepted',
        router_context_version: 'ctx-new',
        technical_settings: {
          lunches_enabled: true,
          departure_lateness_tolerance_sec: 180,
          task_start_lateness_tolerance_sec: 240,
          travel_time_mode: 'fixed_normative',
          access_buffer_sec: 600,
          fixed_travel_time_sec: 1200,
          early_finish_replan_threshold_sec: 900,
          task_overrun_tolerance_sec: 600,
        },
      });
    };
    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100',
      requestTimeoutMs: 1_000,
    });

    assert.deepEqual(await client.getTechnicalSettings(), {
      lunchesEnabled: false,
      departureLatenessToleranceSec: 60,
      taskStartLatenessToleranceSec: 120,
      travelTimeMode: 'graph_with_access_buffer',
      accessBufferSec: 600,
      fixedTravelTimeSec: 1200,
      earlyFinishReplanThresholdSec: 900,
      taskOverrunToleranceSec: 600,
      routerContextVersion: 'ctx-old',
    });
    assert.deepEqual(
      await client.updateTechnicalSettings({
        operationId: 'op-1',
        expectedContextVersion: 'ctx-old',
        lunchesEnabled: true,
        departureLatenessToleranceSec: 180,
        taskStartLatenessToleranceSec: 240,
        travelTimeMode: 'fixed_normative',
        accessBufferSec: 600,
        fixedTravelTimeSec: 1200,
        earlyFinishReplanThresholdSec: 900,
        taskOverrunToleranceSec: 600,
      }),
      {
        operationId: 'op-1',
        status: 'accepted',
        lunchesEnabled: true,
        departureLatenessToleranceSec: 180,
        taskStartLatenessToleranceSec: 240,
        travelTimeMode: 'fixed_normative',
        accessBufferSec: 600,
        fixedTravelTimeSec: 1200,
        earlyFinishReplanThresholdSec: 900,
        taskOverrunToleranceSec: 600,
        routerContextVersion: 'ctx-new',
      },
    );
    assert.equal(requests[1]?.init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      operation_id: 'op-1',
      expected_context_version: 'ctx-old',
      lunches_enabled: true,
      departure_lateness_tolerance_sec: 180,
      task_start_lateness_tolerance_sec: 240,
      travel_time_mode: 'fixed_normative',
      access_buffer_sec: 600,
      fixed_travel_time_sec: 1200,
      early_finish_replan_threshold_sec: 900,
      task_overrun_tolerance_sec: 600,
    });
  });

  it('maps Router context conflicts to a refreshable API conflict', async () => {
    globalThis.fetch = async () => Response.json({ detail: 'CONTEXT_CONFLICT' }, { status: 409 });
    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100',
      requestTimeoutMs: 1_000,
    });
    await assert.rejects(
      () =>
        client.updateTechnicalSettings({
          operationId: 'op-2',
          expectedContextVersion: 'stale',
          lunchesEnabled: false,
          departureLatenessToleranceSec: 0,
          taskStartLatenessToleranceSec: 0,
          travelTimeMode: 'graph_with_access_buffer',
          accessBufferSec: 600,
          fixedTravelTimeSec: 1200,
          earlyFinishReplanThresholdSec: 900,
          taskOverrunToleranceSec: 600,
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'VERSION_CONFLICT',
    );
  });

  it('preserves the new technical controls and comparison metrics from Router', async () => {
    globalThis.fetch = async (input) => {
      if (String(input).endsWith('/v1/context')) {
        return Response.json({
          router_context_version: 'ctx-new-controls',
          technical_settings: {
            lunches_enabled: false,
            departure_lateness_tolerance_sec: 60,
            task_start_lateness_tolerance_sec: 120,
            window_lateness_tolerance_sec: 900,
            traffic_enabled: false,
            equipment_enabled: true,
            travel_time_mode: 'graph_with_access_buffer',
            access_buffer_sec: 600,
            fixed_travel_time_sec: 1200,
            early_finish_replan_threshold_sec: 900,
            task_overrun_tolerance_sec: 600,
          },
        });
      }
      return Response.json({
        input_publication_id: 'publication-1',
        input_hash: 'b'.repeat(64),
        router_context_version: 'ctx-new-controls',
        computed_at: 1_800_000_000,
        search_budget_ms: 8_000,
        rows: [
          {
            strategy_id: 'baseline',
            kind: 'baseline',
            is_usable: true,
            calculation_ms: 4,
            summary: {
              requests_total: 5,
              assigned_count: 4,
              unassigned_count: 1,
              urgent_total: 1,
              urgent_assigned_count: 1,
              engineers_used: 2,
              distance_km: 12.5,
              travel_time_sec: 1800,
              work_time_sec: 7200,
              waiting_time_sec: 300,
              lunch_time_sec: 0,
              late_assigned_count: 2,
              total_lateness_sec: 900,
              min_window_slack_sec: -120,
              workload_spread_sec: 600,
              max_workload_sec: 3_600,
            },
          },
        ],
      });
    };
    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100',
      requestTimeoutMs: 1_000,
    });

    assert.deepEqual(await client.getTechnicalSettings(), {
      lunchesEnabled: false,
      departureLatenessToleranceSec: 60,
      taskStartLatenessToleranceSec: 120,
      windowLatenessToleranceSec: 900,
      trafficEnabled: false,
      equipmentEnabled: true,
      travelTimeMode: 'graph_with_access_buffer',
      accessBufferSec: 600,
      fixedTravelTimeSec: 1200,
      earlyFinishReplanThresholdSec: 900,
      taskOverrunToleranceSec: 600,
      routerContextVersion: 'ctx-new-controls',
    });
    const comparison = await client.getPolicyComparison();
    assert.deepEqual(comparison.rows[0]?.metrics, {
      requestsTotal: 5,
      assignedCount: 4,
      unassignedCount: 1,
      urgentTotal: 1,
      urgentAssignedCount: 1,
      engineersUsed: 2,
      distanceKm: 12.5,
      travelTimeSec: 1800,
      workTimeSec: 7200,
      waitingTimeSec: 300,
      lunchTimeSec: 0,
      lateAssignedCount: 2,
      totalLatenessSec: 900,
      minWindowSlackSec: -120,
      workloadSpreadSec: 600,
      maxWorkloadSec: 3_600,
    });
  });

  it('does not attribute another operation by comparing only the current settings', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({ detail: 'CONTEXT_CONFLICT' }, { status: 409 });
    };
    const client = new HttpRouterClient({
      baseUrl: 'http://router:8100',
      requestTimeoutMs: 1_000,
    });

    await assert.rejects(
      () =>
        client.updateTechnicalSettings({
          operationId: 'lost-response-op',
          expectedContextVersion: 'ctx-before-restart',
          lunchesEnabled: true,
          departureLatenessToleranceSec: 300,
          taskStartLatenessToleranceSec: 600,
          travelTimeMode: 'graph_with_access_buffer',
          accessBufferSec: 600,
          fixedTravelTimeSec: 1200,
          earlyFinishReplanThresholdSec: 900,
          taskOverrunToleranceSec: 600,
        }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'VERSION_CONFLICT',
    );
    assert.equal(calls, 1);
  });

  it('reports non-success status and request timeout', async (context) => {
    await context.test('non-success response', async () => {
      globalThis.fetch = async () => new Response('broken', { status: 503 });
      const client = new HttpRouterClient({
        baseUrl: 'http://router:8100',
        requestTimeoutMs: 1_000,
      });
      await assert.rejects(() => client.getResult(), /HTTP 503/);
    });

    await context.test('timeout', async () => {
      globalThis.fetch = async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      const client = new HttpRouterClient({
        baseUrl: 'http://router:8100',
        requestTimeoutMs: 10,
      });
      await assert.rejects(() => client.getResult(), /timed out after 10 ms/);
    });
  });
});
