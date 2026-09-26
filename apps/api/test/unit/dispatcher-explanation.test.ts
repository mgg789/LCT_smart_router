import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EvidenceReader } from '../../src/ai/explain/evidence.reader';
import {
  runDispatcherCompareAssignments,
  runDispatcherExplainEntity,
} from '../../src/ai/tools/dispatcher-explanation.tools';
import {
  buildDispatcherReadTools,
  type DispatcherReadToolDeps,
} from '../../src/ai/tools/dispatcher-read.tools';
import type { AppliedPlanCurrentShape } from '../../src/api/plan-view.types';
import { simulationPatchHash } from '../../src/orchestrator/simulator';
import type { RouterSimulationPatch } from '../../src/routing/router-gateway';

const requestEvidence = {
  request_id: 'req-1',
  status: 'assigned',
  priority: 'normal',
  required_skill: 'local',
  required_transport: null,
  required_equipment: null,
  service_duration_sec: 1800,
  window_start_at: 1_700_000_000,
  window_end_at: 1_700_003_600,
  engineer_id: 'eng-1',
  stop_id: 'stop-1',
  predecessor_request_id: null,
  arrival_at: 1_700_000_100,
  start_at: 1_700_000_200,
  end_at: 1_700_002_000,
  waiting_time_sec: 100,
  window_start_offset_sec: 200,
  window_end_margin_sec: 3_400,
  travel_time_sec: 100,
  distance_km: 2.4,
  reason_codes: [],
  reasons: [],
  candidates: [
    {
      engineer_id: 'eng-1',
      label: 'Engineer 1',
      skills: ['local'],
      transport_type: 'car',
      equipment_stock: 2,
      release_at: null,
      shift_end_at: 1_700_040_000,
      skill_match: true,
      transport_match: true,
      equipment_match: true,
      available: true,
      solo_feasible: true,
      append_at_route_end_feasible: false,
      append_start_at: null,
      append_end_at: null,
      append_incremental_travel_time_sec: null,
      append_incremental_distance_km: null,
      assigned_job_count: 2,
      blockers: ['current_route_append_infeasible'],
    },
    {
      engineer_id: 'eng-2',
      label: 'Engineer 2',
      skills: ['local'],
      transport_type: 'car',
      equipment_stock: 1,
      release_at: null,
      shift_end_at: 1_700_040_000,
      skill_match: true,
      transport_match: true,
      equipment_match: true,
      available: true,
      solo_feasible: true,
      append_at_route_end_feasible: true,
      append_start_at: 1_700_003_000,
      append_end_at: 1_700_004_800,
      append_incremental_travel_time_sec: 300,
      append_incremental_distance_km: 4.2,
      assigned_job_count: 1,
      blockers: [],
    },
  ],
} as const;

function setup(options: { context?: string; nextContext?: string } = {}) {
  const payload = { main_evidence: { schema_version: '1.0', requests: [requestEvidence] } };
  const plan = {
    id: 'plan-1',
    revision: 7,
    origin: 'auto',
    validatedInputHash: null,
    appliedAt: 1_700_000_030n,
    assignments: [{ requestId: 'req-1', status: 'assigned', engineerId: 'eng-1', reasons: {} }],
    routes: [],
    routerResult: {
      id: 'rr-1',
      resultId: 'result-1',
      accepted: true,
      inputHash: 'hash-1',
      routerContextVersion: options.context ?? 'router-v1',
      computedAt: 1_700_000_020n,
      payload,
    },
  } as unknown as AppliedPlanCurrentShape;
  let reads = 0;
  const simulatedEngineers: string[] = [];
  const deps = {
    prisma: {
      routingCurrent: {
        findUnique: async () => ({ snapshot: { id: 'pub-1', inputHash: 'hash-1' } }),
      },
      request: {
        findUnique: async () => ({
          id: 'req-1',
          windowStartAt: 1_700_000_000n,
          windowEndAt: 1_700_003_600n,
          windowOrigin: 'explicit',
        }),
      },
      $queryRaw: async () => [],
      $executeRaw: async () => 1,
    },
    plans: { current: async () => plan },
    router: {
      getActiveContextVersion: async () => {
        reads += 1;
        return options.nextContext && reads >= 2
          ? options.nextContext
          : (options.context ?? 'router-v1');
      },
      simulate: async (patch: RouterSimulationPatch) => {
        const engineerId = patch.pin?.engineer_id ?? 'missing';
        simulatedEngineers.push(engineerId);
        const assigned = engineerId === 'eng-2' ? 2 : 1;
        return {
          input_hash: 'hash-1',
          input_publication_id: 'pub-1',
          router_context_version: options.context ?? 'router-v1',
          patch_hash: simulationPatchHash(patch),
          method: 'insertion',
          cached: false,
          delta: {
            assigned,
            unassigned: 4 - assigned,
            late_assigned: 0,
            total_lateness_sec: 0,
            distance_km: assigned === 2 ? 8.2 : 10.1,
            transfers: 0,
            before: {
              assigned_count: 1,
              unassigned_count: 3,
              late_assigned_count: 0,
              total_lateness_sec: 0,
              distance_km: 7,
            },
            after: {
              assigned_count: assigned,
              unassigned_count: 4 - assigned,
              late_assigned_count: 0,
              total_lateness_sec: 0,
              distance_km: assigned === 2 ? 8.2 : 10.1,
            },
          },
        };
      },
    },
  } as unknown as DispatcherReadToolDeps;
  return { deps, plan, simulatedEngineers };
}

describe('dispatcher evidence explanation tools', () => {
  it('can explain a current request window before any planning publication exists', async () => {
    const { deps } = setup();
    const unpublished = {
      ...deps,
      prisma: { ...deps.prisma, routingCurrent: { findUnique: async () => null } },
      plans: { current: async () => null },
    } as unknown as DispatcherReadToolDeps;
    const body = JSON.parse(
      (
        await runDispatcherExplainEntity(unpublished, new EvidenceReader(), {
          entity: { type: 'request', id: 'req-1' },
          aspect: 'window',
        })
      ).resultContent,
    );
    assert.equal(body.status, 'available');
    assert.equal(body.factors[0].source.kind, 'current_request');
  });

  for (const args of [
    { pin: { requestId: 'req-1', engineerId: 'eng-2' } },
    { unassignRequestId: 'req-1' },
  ]) {
    it(`does not present bounded search as the effect of ${Object.keys(args)[0]}`, async () => {
      const { deps } = setup();
      const simulate = deps.router.simulate.bind(deps.router);
      deps.router.simulate = async (patch) => ({ ...(await simulate(patch)), method: 'bounded' });
      const tool = buildDispatcherReadTools(deps).find((item) => item.name === 'simulate_change');
      assert.ok(tool);
      const body = JSON.parse((await tool.run({} as never, args)).resultContent);
      assert.equal(body.status, 'unavailable');
      assert.equal(body.delta, undefined);
      assert.equal(body.text, undefined);
    });
  }

  it('retains verified insertion rows but never attributes unconstrained fallback metrics to a pin', async () => {
    const { deps } = setup();
    const simulate = deps.router.simulate.bind(deps.router);
    deps.router.simulate = async (patch) => {
      const result = await simulate(patch);
      return patch.pin?.engineer_id === 'eng-2' ? { ...result, method: 'bounded' } : result;
    };
    const body = JSON.parse(
      (
        await runDispatcherCompareAssignments(deps, new EvidenceReader(), {
          requestId: 'req-1',
          engineerIds: ['eng-1', 'eng-2'],
        })
      ).resultContent,
    );
    assert.equal(body.status, 'partial');
    assert.equal(body.rows[0].method, 'insertion');
    assert.equal(body.rows[0].simulated.distance_km, 10.1);
    assert.equal(body.rows[1].outcome, 'pin_not_verified');
    assert.equal(body.rows[1].simulated, undefined);
    assert.equal(body.rows[1].delta, undefined);
  });

  it('refuses to rank alternatives whose returned baselines differ', async () => {
    const { deps } = setup();
    const simulate = deps.router.simulate.bind(deps.router);
    deps.router.simulate = async (patch) => {
      const result = await simulate(patch);
      return patch.pin?.engineer_id === 'eng-2' && result.delta
        ? {
            ...result,
            delta: { ...result.delta, before: { ...result.delta.before, assigned_count: 999 } },
          }
        : result;
    };
    const body = JSON.parse(
      (
        await runDispatcherCompareAssignments(deps, new EvidenceReader(), {
          requestId: 'req-1',
          engineerIds: ['eng-1', 'eng-2'],
        })
      ).resultContent,
    );
    assert.equal(body.status, 'unavailable');
    assert.equal(body.sharedBaseline, null);
    assert.equal(body.rows[0].delta, undefined);
  });

  it('returns source/version-linked request factors and deterministic follow-up', async () => {
    const { deps } = setup();
    const result = await runDispatcherExplainEntity(deps, new EvidenceReader(), {
      entity: { type: 'request', id: 'req-1' },
      aspect: 'travel',
    });
    assert.ok(result.ok);
    const body = JSON.parse(result.resultContent) as {
      status: string;
      factors: Array<{
        id: string;
        value: { travelTimeSec: number };
        source: { id: string; inputHash: string };
        followUpQuestion: string;
        followUpLink: string;
      }>;
      provenance: { appliedPlanRevision: number; routerEvidenceFresh: boolean };
    };
    assert.equal(body.status, 'available');
    assert.equal(body.factors[0]?.id, 'request.travel');
    assert.equal(body.factors[0]?.value.travelTimeSec, 100);
    assert.equal(body.factors[0]?.source.id, 'result-1');
    assert.equal(body.factors[0]?.source.inputHash, 'hash-1');
    assert.match(body.factors[0]?.followUpQuestion ?? '', /источник и составляющие/);
    assert.ok(body.factors[0]);
    assert.equal(
      body.factors[0]?.followUpLink,
      `#assistant-question=${encodeURIComponent(body.factors[0].followUpQuestion)}`,
    );
    assert.equal(body.provenance.appliedPlanRevision, 7);
    assert.equal(body.provenance.routerEvidenceFresh, true);
  });

  it('simulates one pin per engineer on the same baseline without claiming global ranking', async () => {
    const { deps, simulatedEngineers } = setup();
    const result = await runDispatcherCompareAssignments(deps, new EvidenceReader(), {
      requestId: 'req-1',
      engineerIds: ['eng-1', 'eng-2'],
    });
    assert.ok(result.ok);
    const body = JSON.parse(result.resultContent) as {
      status: string;
      method: string;
      rows: Array<{
        engineerId: string;
        method: string;
        baseline: { distance_km: number };
        simulated: { distance_km: number };
        evidenceCheck: { checks: { appendAtRouteEndFeasible: boolean } } | null;
      }>;
      comparisonScope: string;
    };
    assert.equal(body.status, 'compared');
    assert.equal(body.method, 'router.pin_simulation');
    assert.deepEqual(new Set(simulatedEngineers), new Set(['eng-1', 'eng-2']));
    assert.equal(body.rows[0]?.method, 'insertion');
    assert.equal(body.rows[0]?.baseline.distance_km, 7);
    assert.equal(body.rows[0]?.simulated.distance_km, 10.1);
    assert.equal(body.rows[1]?.baseline.distance_km, 7);
    assert.equal(body.rows[1]?.simulated.distance_km, 8.2);
    assert.equal(body.rows[0]?.evidenceCheck?.checks.appendAtRouteEndFeasible, false);
    assert.match(body.comparisonScope, /не доказательство глобально лучшего/);
  });

  it('does not expose evidence as current after the active Router context changes mid-read', async () => {
    const { deps } = setup({ nextContext: 'router-v2' });
    const result = await runDispatcherCompareAssignments(deps, new EvidenceReader(), {
      requestId: 'req-1',
      engineerIds: ['eng-1', 'eng-2'],
    });
    assert.ok(result.ok);
    const body = JSON.parse(result.resultContent) as { status: string; unavailable: string[] };
    assert.equal(body.status, 'stale');
    assert.match(body.unavailable[0] ?? '', /изменился/);
  });

  it('keeps a calculated pin result even when optional candidate evidence is absent', async () => {
    const { deps } = setup();
    const result = await runDispatcherCompareAssignments(deps, new EvidenceReader(), {
      requestId: 'req-1',
      engineerIds: ['eng-missing'],
    });
    assert.ok(result.ok);
    const body = JSON.parse(result.resultContent) as {
      status: string;
      rows: Array<{ method: string; evidenceCheck: unknown }>;
      unavailable: string[];
    };
    assert.equal(body.status, 'compared');
    assert.equal(body.rows[0]?.method, 'insertion');
    assert.equal(body.rows[0]?.evidenceCheck, null);
    assert.deepEqual(body.unavailable, []);
  });
});
