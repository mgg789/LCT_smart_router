import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiOperationService } from '../../src/ai/operations';
import { buildAiActionCatalog } from '../../src/ai/operations/ai-action.catalog';
import { buildDispatcherReadTools } from '../../src/ai/tools/dispatcher-read.tools';
import { buildDispatcherWriteTools } from '../../src/ai/tools/dispatcher-write.tools';
import type { ToolContext } from '../../src/ai/tools/tool.types';
import type { AppliedPlanCurrentShape } from '../../src/api/plan-view.types';
import type { Actor } from '../../src/auth';
import type { AppConfigService } from '../../src/common/config';
import { SysError } from '../../src/common/errors';
import type { OperationContext } from '../../src/operations';
import type { AlertsService } from '../../src/orchestrator/alerts';
import type { EngineersService } from '../../src/orchestrator/engineers/engineers.service';
import type { LiveService } from '../../src/orchestrator/live/live.service';
import type { PolicyService } from '../../src/orchestrator/policy';
import type { RequestsService } from '../../src/orchestrator/requests/requests.service';
import type { PrismaService } from '../../src/persistence';
import type { SnapshotPublisher } from '../../src/routing/mount-data-eng';
import type {
  AppliedPlanService,
  ControlStateService,
  RouterClient,
} from '../../src/routing/router-gateway';

/** Throws on any access -- the test wires only the exact call path each case exercises. */
function inert<T>(): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('This test only wired the exact call path it exercises');
      },
    },
  ) as unknown as T;
}

const actor: Actor = {
  kind: 'account',
  source: 'ui',
  id: 'dispatcher-1',
  role: 'dispatcher',
  tokenCategory: null,
  accountId: 'dispatcher-1',
};

function toolContext(runId: string): ToolContext {
  return {
    actor,
    accountId: 'dispatcher-1',
    engineerId: null,
    conversationId: 'conv-1',
    runId,
    segments: ['dispatcher'],
    now: 1_700_000_000,
  };
}

describe('The dispatcher AI catalogue never offers a denylisted action', () => {
  // Destructive, credential-bearing or not-yet-approved actions: `context/32` section 6.4
  // (manual mode / plan.reassign / plan.reorder) and `data.dto.ts`'s own confirmation-phrase
  // rule (a reset may be prepared by a human, never confirmed by an AI). None of these
  // exist in the AI action catalogue at all; this test is the regression guard that keeps
  // it that way, or refuses the entry outright if one is ever added without dispatcher_fix
  // deliberately excluded.
  const FORBIDDEN_ACTION_KEYS = [
    'data.reset.demo',
    'data.reset.empty',
    'data.import',
    'data.upload',
    'router.technical-settings.replace',
    'engineer.create',
    'engineer.link_account',
    'engineer.unlink_account',
    'auth.tokens',
    'debug.router-result',
    'control.manual',
    'control.auto',
    'plan.reassign',
    'plan.reorder',
  ];

  const catalog = buildAiActionCatalog({
    requests: inert<RequestsService>(),
    live: inert<LiveService>(),
    engineers: inert<EngineersService>(),
    alerts: inert<AlertsService>(),
    policy: inert<PolicyService>(),
    publisher: inert<SnapshotPublisher>(),
    prisma: inert<PrismaService>(),
    timeZone: 'Europe/Moscow',
  });

  for (const key of FORBIDDEN_ACTION_KEYS) {
    it(`"${key}" is absent, or at least never dispatcher_fix-writable`, () => {
      const spec = catalog.get(key);
      if (!spec) return;
      assert.ok(
        !spec.allowedProfiles.includes('dispatcher_fix'),
        `"${key}" must not be prepared by dispatcher_fix`,
      );
    });
  }

  it('no dispatcher tool name reaches for a denylisted surface', () => {
    const names = buildDispatcherWriteTools({
      aiOperations: inert<AiOperationService>(),
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    }).map((tool) => tool.name);
    for (const forbidden of [
      'reset',
      'import',
      'upload',
      'router_settings',
      'create_engineer',
      'link_engineer',
      'unlink_engineer',
      'auth_token',
      'router_result',
      'set_mode',
      'manual_mode',
      'reassign',
      'reorder',
    ]) {
      assert.ok(
        !names.some((name) => name.includes(forbidden)),
        `no dispatcher tool should touch "${forbidden}", found among ${names.join(', ')}`,
      );
    }
  });
});

describe('prepare_resolve_alert (alert.resolve) refuses an out-of-catalogue action', () => {
  it('rejects add_engineer on a lunch_conflict alert, whose own catalogue is skip_lunch/keep_lunch', async () => {
    const catalog = buildAiActionCatalog({
      requests: inert<RequestsService>(),
      live: inert<LiveService>(),
      engineers: inert<EngineersService>(),
      alerts: inert<AlertsService>(),
      policy: inert<PolicyService>(),
      publisher: inert<SnapshotPublisher>(),
      prisma: {
        alert: {
          findUnique: async () => ({
            id: 'alert-1',
            kind: 'alert',
            code: 'lunch_conflict',
            resolvedAt: null,
            invalidatedAt: null,
          }),
        },
      } as unknown as PrismaService,
      timeZone: 'Europe/Moscow',
    });
    const spec = catalog.get('alert.resolve');
    assert.ok(spec);
    await assert.rejects(
      () =>
        spec.precheck({
          actor,
          accountId: 'dispatcher-1',
          targetRef: 'alert-1',
          payload: { action: 'add_engineer', engineerId: 'eng-1' },
          now: 1_700_000_000,
        }),
      (error: unknown) => error instanceof SysError && error.code === 'VALIDATION_FAILED',
    );
  });

  it('accepts skip_lunch on the same alert', async () => {
    const catalog = buildAiActionCatalog({
      requests: inert<RequestsService>(),
      live: inert<LiveService>(),
      engineers: inert<EngineersService>(),
      alerts: inert<AlertsService>(),
      policy: inert<PolicyService>(),
      publisher: inert<SnapshotPublisher>(),
      prisma: {
        alert: {
          findUnique: async () => ({
            id: 'alert-1',
            kind: 'alert',
            code: 'lunch_conflict',
            resolvedAt: null,
            invalidatedAt: null,
          }),
        },
      } as unknown as PrismaService,
      timeZone: 'Europe/Moscow',
    });
    const spec = catalog.get('alert.resolve');
    assert.ok(spec);
    await spec.precheck({
      actor,
      accountId: 'dispatcher-1',
      targetRef: 'alert-1',
      payload: { action: 'skip_lunch' },
      now: 1_700_000_000,
    });
  });
});

describe('compare_policies is called at most once per run', () => {
  it('a second call in the same run hits the cache instead of recomputing', async () => {
    let calls = 0;
    const comparison = {
      inputPublicationId: 'pub-1',
      inputHash: 'hash-1',
      routerContextVersion: 'v1',
      computedAt: 0,
      searchBudgetMs: 8_000,
      rows: [],
    };
    const tools = buildDispatcherReadTools({
      prisma: inert(),
      live: inert(),
      plans: inert(),
      control: inert(),
      requests: inert(),
      alerts: inert(),
      policy: inert(),
      builder: inert(),
      router: {
        getPolicyComparison: async () => {
          calls += 1;
          return comparison;
        },
      } as unknown as RouterClient,
    });
    const comparePolicies = tools.find((tool) => tool.name === 'compare_policies');
    assert.ok(comparePolicies);
    const ctx = toolContext('run-cache-test');

    const first = await comparePolicies.run(ctx, {});
    const second = await comparePolicies.run(ctx, {});

    assert.equal(calls, 1, 'getPolicyComparison must run at most once for this run');
    assert.ok(first.ok);
    assert.ok(second.ok);
    const secondBody = JSON.parse(second.resultContent) as { cached: boolean; inputHash: string };
    assert.equal(secondBody.cached, true);
    assert.equal(secondBody.inputHash, 'hash-1');

    // A different run gets its own fresh calculation.
    const thirdCtx = toolContext('run-cache-test-2');
    await comparePolicies.run(thirdCtx, {});
    assert.equal(calls, 2);
  });
});

describe('basis survives into a dispatcher tool result', () => {
  it('get_day_plan passes reasons[].basis through unchanged', async () => {
    const planRow: AppliedPlanCurrentShape = {
      id: 'plan-1',
      revision: 1,
      origin: 'auto',
      routerResultId: null,
      planAsOf: 1_700_000_000n,
      appliedAt: 1_700_000_000n,
      routes: [],
      assignments: [
        {
          requestId: 'req-1',
          status: 'unassigned',
          engineerId: null,
          reasons: [
            {
              code: 'NO_FEASIBLE_ASSIGNMENT_FOUND',
              basis: 'calculation_outcome',
              text: 'Bounded search found no slot',
              facts: { idle_skilled_ids: ['eng-9'] },
            },
          ],
        },
      ],
    } as unknown as AppliedPlanCurrentShape;

    const tools = buildDispatcherReadTools({
      prisma: inert(),
      live: inert(),
      plans: { current: async () => planRow } as unknown as AppliedPlanService,
      control: {
        current: async () => ({ mode: 'auto', modeVersion: 1, changedAt: 0, frozenPlanId: null }),
      } as unknown as ControlStateService,
      requests: inert(),
      alerts: inert(),
      policy: inert(),
      builder: inert(),
      router: inert(),
    });
    const getDayPlan = tools.find((tool) => tool.name === 'get_day_plan');
    assert.ok(getDayPlan);
    const result = await getDayPlan.run(toolContext('run-basis-test'), {});
    assert.ok(result.ok);
    const body = JSON.parse(result.resultContent) as {
      plan: { assignments: Array<{ reasons: Array<{ basis: string; code: string }> }> };
    };
    assert.equal(body.plan.assignments[0]?.reasons[0]?.basis, 'calculation_outcome');
    assert.equal(body.plan.assignments[0]?.reasons[0]?.code, 'NO_FEASIBLE_ASSIGNMENT_FOUND');
  });
});

const engineerActor: Actor = {
  kind: 'account',
  source: 'ui',
  id: 'eng-1',
  role: 'engineer',
  tokenCategory: null,
  accountId: 'eng-1',
};

function fullCatalogueDeps(live: LiveService) {
  return {
    requests: inert<RequestsService>(),
    live,
    engineers: inert<EngineersService>(),
    alerts: inert<AlertsService>(),
    policy: inert<PolicyService>(),
    publisher: inert<SnapshotPublisher>(),
    prisma: inert<PrismaService>(),
    timeZone: 'Europe/Moscow',
  };
}

/**
 * `live.engineer.offline` (`LiveService.goOffline`'s AI-prepared counterpart): the
 * engineer's own mid-day stand-down. The precheck mirrors `LiveService.goOffline`'s own
 * refusals so a card is never shown for something certain to fail, and `apply` must reach
 * `LiveService.act` with exactly `kind: 'offline'` -- the same DTO member a direct
 * `/engineer/live/actions` call would use.
 */
describe('live.engineer.offline (the engineer stand-down AI action)', () => {
  it('precheck refuses while the engineer is on a technical break', async () => {
    const catalog = buildAiActionCatalog(
      fullCatalogueDeps({
        engineerView: async () => ({
          engineer: { lineStatus: 'technical_break' },
          current: null,
        }),
      } as unknown as LiveService),
    );
    const spec = catalog.get('live.engineer.offline');
    assert.ok(spec);
    await assert.rejects(
      () =>
        spec.precheck({
          actor: engineerActor,
          accountId: 'eng-1',
          targetRef: 'eng-1',
          payload: { note: 'Плохое самочувствие' },
          now: 1_700_000_000,
        }),
      (error: unknown) => error instanceof SysError && error.code === 'VALIDATION_FAILED',
    );
  });

  it('precheck refuses while a visit is in progress', async () => {
    const catalog = buildAiActionCatalog(
      fullCatalogueDeps({
        engineerView: async () => ({
          engineer: { lineStatus: 'online' },
          current: { phase: 'in_progress', request: { id: 'req-1' } },
        }),
      } as unknown as LiveService),
    );
    const spec = catalog.get('live.engineer.offline');
    assert.ok(spec);
    await assert.rejects(
      () =>
        spec.precheck({
          actor: engineerActor,
          accountId: 'eng-1',
          targetRef: 'eng-1',
          payload: { note: 'Плохое самочувствие' },
          now: 1_700_000_000,
        }),
      (error: unknown) => error instanceof SysError && error.code === 'WORK_ALREADY_STARTED',
    );
  });

  it('precheck accepts a plain online engineer with no current visit', async () => {
    const catalog = buildAiActionCatalog(
      fullCatalogueDeps({
        engineerView: async () => ({
          engineer: { lineStatus: 'online' },
          current: null,
        }),
      } as unknown as LiveService),
    );
    const spec = catalog.get('live.engineer.offline');
    assert.ok(spec);
    await spec.precheck({
      actor: engineerActor,
      accountId: 'eng-1',
      targetRef: 'eng-1',
      payload: { note: 'Плохое самочувствие' },
      now: 1_700_000_000,
    });
  });

  it('apply confirms straight into LiveService.act with kind "offline"', async () => {
    const calls: Array<{ engineerId: string; input: unknown }> = [];
    const catalog = buildAiActionCatalog(
      fullCatalogueDeps({
        act: async (_context: OperationContext, engineerId: string, input: unknown) => {
          calls.push({ engineerId, input });
          return { engineer: { lineStatus: 'stood_down' } };
        },
      } as unknown as LiveService),
    );
    const spec = catalog.get('live.engineer.offline');
    assert.ok(spec);
    const context: OperationContext = {
      tx: inert(),
      now: 1_700_000_000,
      actor: engineerActor,
      operationId: 'op-offline-1',
    };
    await spec.apply({
      actor: engineerActor,
      accountId: 'eng-1',
      targetRef: 'eng-1',
      payload: { note: 'Плохое самочувствие' },
      now: 1_700_000_000,
      context,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.engineerId, 'eng-1');
    assert.deepEqual(calls[0]?.input, {
      operationId: 'op-offline-1',
      kind: 'offline',
      note: 'Плохое самочувствие',
    });
  });
});
