import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiOperationService } from '../../src/ai/operations';
import { buildManualTools } from '../../src/ai/tools/manual.tools';
import { ToolRegistry } from '../../src/ai/tools/tool.registry';
import type { ToolContext } from '../../src/ai/tools/tool.types';
import type { AppConfigService } from '../../src/common/config';
import { mayChangeRequestWindow } from '../../src/orchestrator/requests/window-confirmation';
import type { PrismaService } from '../../src/persistence';

/** Exercise activation separation and stale-catalog execution without touching a real plan. */
describe('builtin manual tools', () => {
  let mode = 'auto';
  let prepared = 0;
  const prisma = {
    controlState: { findUnique: async () => ({ mode }) },
    appState: { findUnique: async () => null },
  } as unknown as PrismaService;
  const aiOperations = {
    prepare: async () => {
      prepared += 1;
      return { state: 'applied' };
    },
  } as unknown as AiOperationService;
  const config = { get: () => 'Europe/Moscow' } as unknown as AppConfigService;
  const tools = buildManualTools({ prisma, aiOperations, config });
  const ctx = {
    actor: {},
    accountId: 'dispatcher',
    conversationId: 'conversation',
    runId: 'run',
  } as ToolContext;
  it('requests human confirmation without enabling manual or preparing a mutation', async () => {
    const tool = tools.find((t) => t.name === 'request_manual_mode');
    assert.ok(tool);
    const result = await tool.run(ctx, { reason: 'Exceptional schedule' });
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(result.resultContent).status, 'manual_not_enabled');
    assert.equal(mode, 'auto');
    assert.equal(prepared, 0);
  });
  it('rejects stale tools in Auto and delegates enabled writes through AI operations', async () => {
    const tool = tools.find((t) => t.name === 'prepare_remove_manual_decision');
    assert.ok(tool);
    await assert.rejects(
      () => tool.run(ctx, { expectedVersion: 1, decisionId: 'intent' }),
      /manual_not_enabled/,
    );
    mode = 'manual';
    assert.equal((await tool.run(ctx, { expectedVersion: 1, decisionId: 'intent' })).ok, true);
    assert.equal(prepared, 1);
    const saved = await tools
      .find((t) => t.name === 'prepare_manual_assignment')
      ?.run(ctx, { expectedVersion: 1, requestId: 'request', engineerId: 'engineer' });
    assert.ok(saved);
    assert.equal(JSON.parse(saved.resultContent).assignmentConfirmed, false);
    assert.equal(JSON.parse(saved.resultContent).intentOutcome, 'pending');
    assert.ok(saved.summary.includes('НЕ подтверждено'));
    mode = 'auto';
    await assert.rejects(
      () => tool.run(ctx, { expectedVersion: 1, decisionId: 'intent' }),
      /manual_not_enabled/,
    );
    assert.equal(prepared, 2);
  });
  it('refreshes the exposed catalogue after external mode changes', async () => {
    const fake = {
      prisma,
      llmSpecsFor: () =>
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: {},
        })),
    } as unknown as ToolRegistry;
    mode = 'auto';
    assert.deepEqual(
      (await ToolRegistry.prototype.liveSpecsFor.call(fake, 'dispatcher_fix')).map((t) => t.name),
      ['request_manual_mode'],
    );
    mode = 'manual';
    assert.equal(
      (await ToolRegistry.prototype.liveSpecsFor.call(fake, 'dispatcher_fix')).length,
      tools.length,
    );
    mode = 'auto';
    assert.equal(
      (await ToolRegistry.prototype.liveSpecsFor.call(fake, 'dispatcher_fix')).length,
      1,
    );
  });
  it('manual windows retain mandatory human window approval', () => {
    assert.equal(mayChangeRequestWindow('manual.decision.put', { kind: 'window' }), true);
    assert.equal(mayChangeRequestWindow('manual.decision.put', { kind: 'assignment' }), false);
  });
});
