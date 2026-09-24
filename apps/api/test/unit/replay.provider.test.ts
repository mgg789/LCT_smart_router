import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LlmStreamEvent, LlmTurnInput } from '../../src/ai/provider/llm.types';
import { fixtureKey, ReplayProvider } from '../../src/ai/provider/replay.provider';
import { FixedClock } from '../../src/common/time';

async function drain(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

function turnInput(text: string, signal: AbortSignal = new AbortController().signal): LlmTurnInput {
  return {
    model: 'test-model',
    system: 'system prompt',
    messages: [{ role: 'user', content: text }],
    tools: [],
    maxOutputTokens: 256,
    signal,
  };
}

describe('replay provider', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-replay-'));
    await writeFile(
      join(dir, `${fixtureKey('Hello there')}.json`),
      JSON.stringify({
        reply: 'Hi! How can I help?',
        chunkSize: 5,
        usage: { promptTokens: 3, completionTokens: 6 },
      }),
    );
    await writeFile(
      join(dir, 'forced-scenario.json'),
      JSON.stringify({
        reply: 'Scenario reply',
        toolCalls: [{ name: 'test_tool', arguments: { a: 1 } }],
      }),
    );
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers with the fixture matched by a normalised hash of the last user message', async () => {
    const provider = new ReplayProvider(dir, undefined, new FixedClock(1_000));
    // Extra whitespace and casing must hit the same fixture as the exact text.
    const events = await drain(provider.turn(turnInput('  Hello THERE  ')));
    const text = events
      .filter(
        (event): event is Extract<LlmStreamEvent, { type: 'text_delta' }> =>
          event.type === 'text_delta',
      )
      .map((event) => event.text)
      .join('');
    assert.equal(text, 'Hi! How can I help?');
    const done = events.at(-1);
    assert.equal(done?.type, 'done');
    assert.equal(done && done.type === 'done' ? done.finishReason : undefined, 'stop');
  });

  it('is forced to one fixture by a configured scenario regardless of what was typed', async () => {
    const provider = new ReplayProvider(dir, 'forced-scenario', new FixedClock(1_000));
    const events = await drain(provider.turn(turnInput('this text is completely unrelated')));
    const toolCall = events.find((event) => event.type === 'tool_call');
    assert.ok(toolCall, 'expected the forced fixture to surface its tool call');
    const done = events.find((event) => event.type === 'done');
    assert.equal(done && done.type === 'done' ? done.finishReason : undefined, 'tool_calls');
  });

  it('degrades to one fixed, honest sentence for input with no recorded fixture -- it never throws', async () => {
    const provider = new ReplayProvider(dir, undefined, new FixedClock(1_000));
    const events = await drain(
      provider.turn(turnInput('a completely free-typed question nobody scripted')),
    );
    const text = events
      .filter(
        (event): event is Extract<LlmStreamEvent, { type: 'text_delta' }> =>
          event.type === 'text_delta',
      )
      .map((event) => event.text)
      .join('');
    // Asserted as behaviour rather than as one sentence: the reply reaches a person in the
    // chat, so its wording is product copy and belongs to the product's language, and
    // pinning the exact string here would make rewording it look like a broken contour.
    assert.ok(text.length > 0, 'an unmatched input must still produce an answer');
    assert.match(text, /[А-Яа-яЁё]/, 'the fallback is shown to a user, so it is in Russian');
    assert.doesNotMatch(text, /undefined|null|\[object/i);
    assert.equal(events.at(-1)?.type, 'done');
  });

  it('ends with `aborted` instead of throwing when the signal is already aborted', async () => {
    const provider = new ReplayProvider(dir, undefined, new FixedClock(1_000));
    const controller = new AbortController();
    controller.abort();
    const events = await drain(provider.turn(turnInput('Hello there', controller.signal)));
    assert.equal(events.length, 1);
    const [only] = events;
    assert.equal(only?.type, 'done');
    assert.equal(only && only.type === 'done' ? only.finishReason : undefined, 'aborted');
  });

  it('is always configured -- it has no external dependency to be missing', () => {
    const provider = new ReplayProvider(dir, undefined, new FixedClock(1_000));
    assert.equal(provider.isConfigured(), true);
  });
});
