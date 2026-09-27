import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildOperationVerificationTool } from '../../src/ai/tools/operation-verification.tool';
import type { ToolContext } from '../../src/ai/tools/tool.types';
import type { PrismaService } from '../../src/persistence';

const ctx = { accountId: 'account', conversationId: 'chat', now: 100 } as ToolContext;

function harness(
  state = 'applied',
  appliedHash: string | null = 'current',
  found = true,
  validatedInputHash: string | null = null,
) {
  let lookup: unknown;
  let isolation: unknown;
  const tx = {
    aiOperation: {
      findFirst: async (input: unknown) => {
        lookup = input;
        return found
          ? { id: 'op', state, action: 'alert.resolve', targetRef: 'alert', completedAt: 90n }
          : null;
      },
    },
    alert: {
      findUnique: async () => ({
        id: 'alert',
        code: 'time_risk',
        requestIds: ['request'],
        engineerIds: [],
        resolvedAt: 90n,
        invalidatedAt: null,
      }),
      findMany: async () => [{ id: 'new-alert', code: 'unassigned', severity: 'warning' }],
    },
    routingCurrent: { findUnique: async () => ({ snapshot: { inputHash: 'current' } }) },
    appliedPlanCurrent: {
      findUnique: async () => ({
        plan: {
          revision: 2,
          validatedInputHash,
          routerResult: appliedHash ? { inputHash: appliedHash } : null,
        },
      }),
    },
  };
  const prisma = {
    $transaction: async (fn: (transaction: typeof tx) => Promise<unknown>, options: unknown) => {
      isolation = options;
      return fn(tx);
    },
  } as unknown as PrismaService;
  return {
    tool: buildOperationVerificationTool(prisma),
    lookup: () => lookup,
    isolation: () => isolation,
  };
}

describe('operation effect verification', () => {
  it('scopes operation reads to both the signed-in account and current conversation', async () => {
    const subject = harness();
    await subject.tool.run(ctx, { operationId: 'op' });
    assert.deepEqual(subject.isolation(), { isolationLevel: 'RepeatableRead' });
    assert.deepEqual((subject.lookup() as { where: unknown }).where, {
      id: 'op',
      accountId: 'account',
      conversationId: 'chat',
    });
  });

  it('does not leak another conversation operation or proceed with follow-up reads', async () => {
    const { tool } = harness('applied', 'current', false);
    await assert.rejects(() => tool.run(ctx, { operationId: 'op' }), /AI operation/);
  });

  for (const state of [
    'prepared',
    'awaiting_confirmation',
    'rejected',
    'outcome_unknown',
    'failed',
  ]) {
    it(`never reports ${state} as an applied operation`, async () => {
      const result = JSON.parse(
        (await harness(state).tool.run(ctx, { operationId: 'op' })).resultContent,
      );
      assert.equal(result.operationApplied, false);
      assert.equal(result.problemResolution, 'requires_assessment');
    });
  }

  it('separates successful application from remaining problems and pending recalculation', async () => {
    const result = JSON.parse(
      (await harness('applied', 'previous').tool.run(ctx, { operationId: 'op' })).resultContent,
    );
    assert.equal(result.operationApplied, true);
    assert.equal(result.originalAlert.state, 'resolved');
    assert.equal(result.relatedOpenAlerts[0].id, 'new-alert');
    assert.equal(result.planning.status, 'awaiting_current_plan');
    assert.equal(result.problemResolution, 'requires_assessment');
  });

  it('does not infer plan freshness when its source is unknown', async () => {
    const result = JSON.parse(
      (await harness('applied', null).tool.run(ctx, { operationId: 'op' })).resultContent,
    );
    assert.equal(result.planning.status, 'unverified');
  });

  it('recognizes a restored plan validated against the current input', async () => {
    const result = JSON.parse(
      (await harness('applied', 'original', true, 'current').tool.run(ctx, { operationId: 'op' }))
        .resultContent,
    );
    assert.equal(result.planning.status, 'matches_published_input');
    assert.equal(result.planning.appliedInputHash, 'current');
    assert.equal(result.problemResolution, 'requires_assessment');
  });
});
