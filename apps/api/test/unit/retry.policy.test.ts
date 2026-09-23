import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AiProviderKind,
  EMPTY_PROVIDER_OUTCOME,
  type LlmStreamEvent,
  type LlmTurnInput,
} from '../../src/ai/provider/llm.types';
import type { LlmProvider } from '../../src/ai/provider/llm-provider.port';
import {
  decideRetry,
  LlmCallError,
  type RetryRunResult,
  runProviderTurn,
} from '../../src/ai/provider/retry.policy';

describe('retry policy: decideRetry', () => {
  it('never retries an auth failure, regardless of remaining budget or a fallback', () => {
    const decision = decideRetry({
      classification: 'auth',
      attemptsSoFar: 1,
      maxAttempts: 5,
      hasFallback: true,
      usedFallback: false,
      startedStreaming: false,
      stopRequested: false,
    });
    assert.equal(decision.action, 'give_up');
  });

  it('never retries once the stop flag is set, even with a fallback available', () => {
    const decision = decideRetry({
      classification: 'server',
      attemptsSoFar: 1,
      maxAttempts: 5,
      hasFallback: true,
      usedFallback: false,
      startedStreaming: false,
      stopRequested: true,
    });
    assert.equal(decision.action, 'give_up');
  });

  it('stops retrying once any content has already streamed, even for a retryable failure', () => {
    const decision = decideRetry({
      classification: 'transport',
      attemptsSoFar: 1,
      maxAttempts: 5,
      hasFallback: false,
      usedFallback: false,
      startedStreaming: true,
      stopRequested: false,
    });
    assert.equal(decision.action, 'give_up');
  });

  it('keeps the total attempt count within the budget, reserving exactly one for the fallback', () => {
    const actions: string[] = [];
    let attempts = 0;
    let usedFallback = false;
    for (let i = 0; i < 10; i += 1) {
      attempts += 1;
      const decision = decideRetry({
        classification: 'server',
        attemptsSoFar: attempts,
        maxAttempts: 3,
        hasFallback: true,
        usedFallback,
        startedStreaming: false,
        stopRequested: false,
      });
      actions.push(decision.action);
      if (decision.action === 'give_up') {
        break;
      }
      if (decision.action === 'retry_fallback') {
        usedFallback = true;
      }
    }
    assert.deepEqual(actions, ['retry_same', 'retry_fallback', 'give_up']);
    assert.ok(attempts <= 3, `attempts (${attempts}) must never exceed maxAttempts`);
  });

  it('retries the primary for the whole budget when there is no fallback', () => {
    let attempts = 0;
    let action: string = 'retry_same';
    while (action !== 'give_up') {
      attempts += 1;
      action = decideRetry({
        classification: 'rate_limit',
        attemptsSoFar: attempts,
        maxAttempts: 4,
        hasFallback: false,
        usedFallback: false,
        startedStreaming: false,
        stopRequested: false,
      }).action;
    }
    assert.equal(attempts, 4);
  });
});

/** An `AsyncIterable` that fails on the first pull without ever yielding, so it does not
 *  trip Biome's "generator without yield" rule the way an `async function*` that always
 *  throws would. */
function alwaysFails(error: unknown): AsyncIterable<LlmStreamEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<LlmStreamEvent>> => Promise.reject(error),
    }),
  };
}

async function* succeedsWith(events: readonly LlmStreamEvent[]): AsyncGenerator<LlmStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function fakeProvider(
  kind: AiProviderKind,
  turn: (input: LlmTurnInput) => AsyncIterable<LlmStreamEvent>,
): LlmProvider {
  return {
    kind,
    isConfigured: () => true,
    turn,
    lastOutcome: () => EMPTY_PROVIDER_OUTCOME,
  } as LlmProvider;
}

function turnInput(): LlmTurnInput {
  return {
    model: 'x',
    system: 's',
    messages: [],
    tools: [],
    maxOutputTokens: 100,
    signal: new AbortController().signal,
  };
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) {
    out.push(value);
  }
  return out;
}

describe('retry policy: runProviderTurn', () => {
  it('never exceeds the attempt budget across primary retries and the fallback hop', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = fakeProvider('replay', () => {
      primaryCalls += 1;
      return alwaysFails(new LlmCallError('boom', 'server'));
    });
    const fallback = fakeProvider('replay', () => {
      fallbackCalls += 1;
      return alwaysFails(new LlmCallError('boom', 'server'));
    });
    const result: { current: RetryRunResult } = {
      current: { providerKind: 'replay', usedFallback: false, attempts: 0 },
    };

    await assert.rejects(() => drain(runProviderTurn(turnInput(), primary, fallback, 3, result)));
    assert.equal(primaryCalls + fallbackCalls, 3);
    assert.equal(fallbackCalls, 1);
  });

  it('stops immediately on an auth failure without ever trying the fallback', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = fakeProvider('replay', () => {
      primaryCalls += 1;
      return alwaysFails(new LlmCallError('nope', 'auth'));
    });
    const fallback = fakeProvider('replay', () => {
      fallbackCalls += 1;
      return succeedsWith([
        { type: 'done', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } },
      ]);
    });
    const result: { current: RetryRunResult } = {
      current: { providerKind: 'replay', usedFallback: false, attempts: 0 },
    };

    await assert.rejects(() => drain(runProviderTurn(turnInput(), primary, fallback, 5, result)));
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 0);
  });

  it('a stop already requested cancels the fallback hop instead of using it', async () => {
    const controller = new AbortController();
    let fallbackCalls = 0;
    const primary = fakeProvider('replay', () => alwaysFails(new LlmCallError('down', 'server')));
    const fallback = fakeProvider('replay', () => {
      fallbackCalls += 1;
      return succeedsWith([
        { type: 'done', finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0 } },
      ]);
    });
    const result: { current: RetryRunResult } = {
      current: { providerKind: 'replay', usedFallback: false, attempts: 0 },
    };
    controller.abort();

    await assert.rejects(() =>
      drain(
        runProviderTurn(
          { ...turnInput(), signal: controller.signal },
          primary,
          fallback,
          5,
          result,
        ),
      ),
    );
    assert.equal(fallbackCalls, 0, 'a stop must cancel the fallback hop, not spend it');
  });

  it('succeeds through the fallback once the primary is exhausted, and forwards its events live', async () => {
    const primary = fakeProvider('replay', () => alwaysFails(new LlmCallError('down', 'server')));
    const fallback = fakeProvider('replay', () =>
      succeedsWith([
        { type: 'text_delta', text: 'ok' },
        { type: 'done', finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } },
      ]),
    );
    const result: { current: RetryRunResult } = {
      current: { providerKind: 'replay', usedFallback: false, attempts: 0 },
    };

    const events = await drain(runProviderTurn(turnInput(), primary, fallback, 2, result));
    assert.equal(
      events.some((event) => event.type === 'text_delta'),
      true,
    );
    assert.equal(result.current.usedFallback, true);
    assert.equal(result.current.attempts, 2);
    assert.equal(result.current.providerKind, 'replay');
  });
});
