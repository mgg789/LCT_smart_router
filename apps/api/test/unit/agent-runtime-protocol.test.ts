import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Subject } from 'rxjs';
import type {
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
  LlmTurnInput,
  ProviderOutcome,
} from '../../src/ai/provider';
import { LlmCallError } from '../../src/ai/provider/retry.policy';
import { AgentRuntimeService } from '../../src/ai/runtime/agent-runtime.service';
import type { AiRunEvent } from '../../src/ai/runtime/ai-event.types';
import type { RunHandle } from '../../src/ai/runtime/run-registry';
import { FixedClock } from '../../src/common/time';
import type { AiConversation } from '../../src/generated/prisma/client';

interface HarnessOptions {
  readonly events: readonly LlmStreamEvent[];
  readonly providerKind?: 'replay' | 'openai_chat';
  readonly reasoningEffort?: 'none' | 'low';
  readonly failAfterEvents?: number;
  readonly maxToolSteps?: number;
}

function harness(options: HarnessOptions) {
  const outputEvents: AiRunEvent[] = [];
  const storedTurns: unknown[] = [];
  let dispatches = 0;
  let primaryCalls = 0;
  let fallbackCalls = 0;
  let updatedRun: { state?: string } = {};
  let messageWrites = 0;
  let eventSeq = 0;
  const provider = {
    kind: options.providerKind ?? 'replay',
    isConfigured: () => true,
    lastOutcome: (): ProviderOutcome => ({
      lastOkAt: 100,
      lastFailureAt: null,
      consecutiveFailures: 0,
      authFailed: false,
      lastErrorMessage: null,
    }),
    async *turn(_input: LlmTurnInput) {
      primaryCalls += 1;
      for (let index = 0; index < options.events.length; index += 1) {
        if (options.failAfterEvents === index)
          throw new LlmCallError('stream ended early', 'server');
        yield options.events[index] as LlmStreamEvent;
      }
      if (options.failAfterEvents === options.events.length) {
        throw new LlmCallError('stream ended early', 'server');
      }
    },
  } as unknown as LlmProvider;
  const fallback = {
    ...provider,
    async *turn() {
      fallbackCalls += 1;
      yield {
        type: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0 },
      } as LlmStreamEvent;
    },
  } as unknown as LlmProvider;
  const config = {
    get(key: string) {
      const values: Record<string, unknown> = {
        LLM_MODEL: 'test-model',
        LLM_MAX_OUTPUT_TOKENS: 1024,
        LLM_MAX_ATTEMPTS: 3,
        LLM_MAX_TOOL_STEPS: options.maxToolSteps ?? 0,
        AI_HISTORY_MESSAGES: 20,
        APP_TIME_ZONE: 'UTC',
        AI_UNITS_PER_1K_PROMPT_MICROS: 1,
        AI_UNITS_PER_1K_COMPLETION_MICROS: 1,
        LLM_CHAT_REASONING_EFFORT: options.reasoningEffort ?? 'none',
      };
      return values[key];
    },
  };
  const service = new AgentRuntimeService(
    {
      aiRun: {
        update: async (args: { data: { state: string } }) => {
          updatedRun = args.data;
        },
      },
    } as never,
    {} as never,
    new FixedClock(100),
    config as never,
    {
      providerHistoryWindow: async () => ({
        messages: [{ role: 'user', content: 'Do this' } satisfies LlmMessage],
        userSeq: 1,
      }),
      appendProviderHistory: async (_id: string, _lane: string, turn: unknown) => {
        storedTurns.push(turn);
      },
      appendMessage: async () => {
        messageWrites += 1;
        return { seq: 2 };
      },
    } as never,
    { settle: async () => undefined } as never,
    { remove: () => undefined } as never,
    {
      emit: async (_handle: unknown, event: Omit<AiRunEvent, 'seq' | 'at'>) => {
        const saved = { ...event, seq: ++eventSeq, at: 100 } as AiRunEvent;
        outputEvents.push(saved);
        return saved;
      },
      forget: () => undefined,
    } as never,
    { checkpoint: () => undefined } as never,
    provider,
    fallback,
    {
      dispatch: async () => {
        dispatches += 1;
        return { ok: true, summary: 'done', resultContent: '{}' };
      },
    } as never,
    {
      liveSpecsFor: async () => [
        { name: 'write_plan', description: 'write', parametersJsonSchema: {} },
      ],
    } as never,
    { publishMessage: () => undefined } as never,
  );
  const conversation = {
    id: 'conversation-1',
    roleProfile: 'dispatcher_fix',
  } as unknown as AiConversation;
  const handle = {
    runId: 'run-1',
    abort: new AbortController(),
    events: new Subject<AiRunEvent>(),
  };

  return {
    async run() {
      await (
        service as unknown as {
          drive(
            runId: string,
            conversation: AiConversation,
            actor: unknown,
            accountId: string,
            reservation: { readonly quotaDay: string; readonly reservedMicros: number },
            handle: RunHandle,
          ): Promise<void>;
        }
      ).drive(
        'run-1',
        conversation,
        {} as never,
        'account-1',
        { quotaDay: '2026-09-27', reservedMicros: 1 },
        handle,
      );
    },
    outputEvents,
    storedTurns,
    dispatchCount: () => dispatches,
    providerCallCount: () => primaryCalls,
    fallbackCallCount: () => fallbackCalls,
    runState: () => updatedRun.state,
    messageWriteCount: () => messageWrites,
  };
}

describe('agent runtime provider protocol guards', () => {
  it('does not dispatch calls hallucinated on the reserved no-tools final turn', async () => {
    const test = harness({
      events: [
        { type: 'tool_call', call: { id: 'call-1', name: 'write_plan', arguments: {} } },
        {
          type: 'done',
          finishReason: 'tool_calls',
          usage: { promptTokens: 1, completionTokens: 1 },
        },
      ],
    });
    await test.run();
    assert.equal(test.dispatchCount(), 0);
    assert.equal(test.runState(), 'failed');
  });

  it('keeps reasoning-only length output private and fails without inventing a final answer', async () => {
    const test = harness({
      providerKind: 'openai_chat',
      reasoningEffort: 'low',
      events: [
        { type: 'reasoning', content: 'Private scratchpad.' },
        { type: 'done', finishReason: 'length', usage: { promptTokens: 1, completionTokens: 1 } },
      ],
    });
    await test.run();
    assert.equal(test.messageWriteCount(), 0);
    assert.equal(
      test.outputEvents.some((event) => JSON.stringify(event).includes('Private scratchpad.')),
      false,
    );
    assert.equal(test.storedTurns.length, 1);
    assert.equal(JSON.stringify(test.storedTurns[0]).includes('Private scratchpad.'), true);
    assert.equal(test.runState(), 'failed');
  });

  it('does not retry or dispatch a partial tool call from a failed stream', async () => {
    const test = harness({
      maxToolSteps: 1,
      events: [{ type: 'tool_call', call: { id: 'call-1', name: 'write_plan', arguments: {} } }],
      failAfterEvents: 1,
    });
    await test.run();
    assert.equal(test.providerCallCount(), 1);
    assert.equal(test.fallbackCallCount(), 0);
    assert.equal(test.dispatchCount(), 0);
    assert.equal(test.runState(), 'failed');
  });

  it('does not execute a low-thinking tool call when reasoning state was absent', async () => {
    const test = harness({
      providerKind: 'openai_chat',
      reasoningEffort: 'low',
      maxToolSteps: 1,
      events: [
        { type: 'tool_call', call: { id: 'call-1', name: 'write_plan', arguments: {} } },
        {
          type: 'done',
          finishReason: 'tool_calls',
          usage: { promptTokens: 1, completionTokens: 1 },
        },
      ],
    });
    await test.run();
    assert.equal(test.dispatchCount(), 0);
    assert.equal(test.runState(), 'failed');
  });
});
