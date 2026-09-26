import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEngineerTools } from '../../src/ai/tools/engineer.tools';
import type { ToolContext } from '../../src/ai/tools/tool.types';
import type { AppConfigService } from '../../src/common/config';
import type { AiOperationService } from '../../src/ai/operations';
import type { LiveService } from '../../src/orchestrator/live/live.service';
import type { PassportsService } from '../../src/orchestrator/passports/passports.service';
import type { Actor } from '../../src/auth';

const engineerActor = { id: 'account-1', roles: ['engineer'] } as unknown as Actor;

function context(engineerId: string | null): ToolContext {
  return {
    actor: engineerActor,
    accountId: 'account-1',
    engineerId,
    conversationId: 'conversation-1',
    runId: 'run-1',
    segments: ['engineer'],
    now: 1_790_000_000,
  };
}

function liveView(currentRequestId: string | null) {
  const current = currentRequestId
    ? {
        request: {
          id: currentRequestId,
          version: 7,
          addressText: 'ул. Тестовая, 1',
          requiredEquipment: 'router',
          windowStartAt: 1_790_000_100,
          windowEndAt: 1_790_000_500,
        },
        phase: 'ready_to_start' as const,
        expectedCompletionAt: null,
        overrunAt: null,
        stop: null,
      }
    : null;
  return {
    handoffs: [],
    workday: {
      status: 'running' as const,
      workDate: '2026-09-26',
      planRevision: 12,
      liveNow: 1_790_000_000,
    },
    engineer: { name: 'Иван', lineStatus: 'online', lunchInterval: null },
    route: null,
    current,
    lunch: null,
  };
}

function visitContextTool(live: LiveService, passports: PassportsService) {
  return buildEngineerTools({
    aiOperations: {} as AiOperationService,
    live,
    passports,
    config: {} as AppConfigService,
  }).find((tool) => tool.name === 'get_my_visit_context');
}

describe('get_my_visit_context', () => {
  it('keeps the existing route tool readable without serializing the private context', async () => {
    const tools = buildEngineerTools({
      aiOperations: {} as AiOperationService,
      live: { engineerView: async () => liveView(null) } as unknown as LiveService,
      passports: {} as PassportsService,
      config: { get: () => 'Europe/Moscow' } as unknown as AppConfigService,
    });
    const tool = tools.find((item) => item.name === 'get_my_route');
    assert.ok(tool);
    const result = await tool.run(context('engineer-session'), {});
    assert.match(result.resultContent, /[А-Яа-я]/);
    assert.doesNotMatch(result.resultContent, /"currentVisit"|"planRevision"|"brief"/);
    assert.throws(() => JSON.parse(result.resultContent));
  });

  it('uses the signed-in engineer and defaults to their current visit', async () => {
    const engineerView = liveView('request-current');
    const reads: Array<[string, string]> = [];
    const passports = {
      engineerRead: async (engineerId: string, requestId: string) => {
        reads.push([engineerId, requestId]);
        return { passport: { address: 'ул. Тестовая, 1' }, canFill: false };
      },
    } as unknown as PassportsService;
    const live = { engineerView: async () => engineerView } as unknown as LiveService;
    const tool = visitContextTool(live, passports);
    assert.ok(tool);

    const result = await tool.run(context('engineer-session'), {});
    assert.deepEqual(reads, [['engineer-session', 'request-current']]);
    const payload = JSON.parse(result.resultContent) as {
      currentVisit: { requestId: string; requestVersion: number; requiredEquipment: string };
      inventory: { status: string };
      selectedRequestIsCurrent: boolean;
      passport: { passport: { address: string } };
    };
    assert.equal(payload.currentVisit.requestId, 'request-current');
    assert.equal(payload.currentVisit.requestVersion, 7);
    assert.equal(payload.currentVisit.requiredEquipment, 'router');
    assert.equal(payload.inventory.status, 'unavailable');
    assert.equal(payload.selectedRequestIsCurrent, true);
    assert.equal(payload.passport.passport.address, 'ул. Тестовая, 1');
  });

  it('lets the passport service authorize an explicitly selected assigned request, without accepting a caller identity', async () => {
    const reads: Array<[string, string]> = [];
    const passports = {
      engineerRead: async (engineerId: string, requestId: string) => {
        reads.push([engineerId, requestId]);
        return { passport: null, canFill: false };
      },
    } as unknown as PassportsService;
    const live = { engineerView: async () => liveView(null) } as unknown as LiveService;
    const tool = visitContextTool(live, passports);
    assert.ok(tool);

    await tool.run(context('engineer-session'), { requestId: 'assigned-request' });
    assert.deepEqual(reads, [['engineer-session', 'assigned-request']]);
    assert.equal(tool.schema.safeParse({ requestId: 'assigned-request', engineerId: 'other' }).success, false);
  });

  it('does not query the passport service if no visit is available', async () => {
    let readCount = 0;
    const passports = {
      engineerRead: async () => {
        readCount += 1;
        return { passport: null, canFill: false };
      },
    } as unknown as PassportsService;
    const live = { engineerView: async () => liveView(null) } as unknown as LiveService;
    const tool = visitContextTool(live, passports);
    assert.ok(tool);

    const result = await tool.run(context('engineer-session'), {});
    assert.equal(readCount, 0);
    assert.match(result.resultContent, /"currentVisit":null/);
    assert.match(result.resultContent, /"passport":null/);
    assert.match(result.resultContent, /"selectedRequestIsCurrent":false/);
  });

  it('rejects access if no engineer is bound to the signed-in session', async () => {
    const passports = { engineerRead: async () => ({ passport: null, canFill: false }) } as unknown as PassportsService;
    const live = { engineerView: async () => liveView(null) } as unknown as LiveService;
    const tool = visitContextTool(live, passports);
    assert.ok(tool);
    await assert.rejects(() => tool.run(context(null), { requestId: 'assigned-request' }), /signed-in engineer/);
  });
});
