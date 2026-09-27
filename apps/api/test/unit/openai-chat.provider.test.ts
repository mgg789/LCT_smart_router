import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { LlmStreamEvent, LlmTurnInput } from '../../src/ai/provider/llm.types';
import { OpenAiChatProvider } from '../../src/ai/provider/openai-chat.provider';
import { FixedClock } from '../../src/common/time';

async function drain(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const result: LlmStreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function input(messages: LlmTurnInput['messages'] = []): LlmTurnInput {
  return {
    model: 'deepseek-flash',
    system: 'system',
    messages,
    tools: [
      { name: 'read_plan', description: 'Read the plan', parametersJsonSchema: { type: 'object' } },
    ],
    maxOutputTokens: 2048,
    signal: new AbortController().signal,
  };
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chunk',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-flash',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  } as unknown as ChatCompletionChunk;
}

describe('OpenAI-compatible chat provider', () => {
  it('opts into low DeepSeek reasoning and carries it back with assistant tool calls', async () => {
    const requests: Record<string, unknown>[] = [];
    const responses = [
      [
        chunk({ reasoning_content: 'Check current assignments.' }),
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'read_plan', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        ),
      ],
      [chunk({ content: 'The plan has one route.' }, 'stop')],
    ];
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            requests.push(body);
            return (async function* () {
              for (const part of responses.shift() ?? []) yield part;
            })();
          },
        },
      },
    } as unknown as OpenAI;
    const provider = new OpenAiChatProvider(client, new FixedClock(100), 'low');

    const first = await drain(provider.turn(input()));
    const reasoning = first
      .filter(
        (event): event is Extract<LlmStreamEvent, { type: 'reasoning' }> =>
          event.type === 'reasoning',
      )
      .map((event) => event.content)
      .join('');
    const toolCall = first.find((event) => event.type === 'tool_call');
    assert.equal(reasoning, 'Check current assignments.');
    assert.ok(toolCall && toolCall.type === 'tool_call');
    assert.equal(
      requests[0]?.thinking && (requests[0].thinking as { type: string }).type,
      'enabled',
    );
    assert.equal(requests[0]?.reasoning_effort, 'low');

    const next = input([
      { role: 'assistant', content: null, reasoningContent: reasoning, toolCalls: [toolCall.call] },
      { role: 'tool', toolCallId: 'call-1', name: 'read_plan', content: '{"routes":1}' },
    ]);
    await drain(provider.turn(next));
    const messages = requests[1]?.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === 'assistant');
    assert.equal(assistant?.reasoning_content, reasoning);
    assert.deepEqual(assistant?.tool_calls, [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'read_plan', arguments: '{}' },
      },
    ]);
  });

  it('leaves provider thinking disabled unless low effort is explicitly configured', async () => {
    const requests: Record<string, unknown>[] = [];
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            requests.push(body);
            return (async function* () {
              yield chunk({ content: 'Done.' }, 'stop');
            })();
          },
        },
      },
    } as unknown as OpenAI;
    const provider = new OpenAiChatProvider(client, new FixedClock(100));
    await drain(provider.turn(input()));
    assert.deepEqual(requests[0]?.thinking, { type: 'disabled' });
    assert.equal(requests[0]?.reasoning_effort, undefined);
  });

  it('never emits a valid-looking tool call when the stream ends at the length limit', async () => {
    const client = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield chunk(
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-truncated',
                      type: 'function',
                      function: { name: 'read_plan', arguments: '{"route":"valid-prefix"}' },
                    },
                  ],
                },
                'length',
              );
            })(),
        },
      },
    } as unknown as OpenAI;
    const provider = new OpenAiChatProvider(client, new FixedClock(100));
    const events = await drain(provider.turn(input()));
    assert.equal(events.filter((event) => event.type === 'tool_call').length, 0);
    assert.equal(
      events.find((event) => event.type === 'done')?.type === 'done'
        ? events.find((event) => event.type === 'done')?.finishReason
        : undefined,
      'length',
    );
  });

  it('keeps reasoning-only length output private and does not turn it into visible text', async () => {
    const client = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield chunk({ reasoning_content: 'Private scratchpad only.' }, 'length');
            })(),
        },
      },
    } as unknown as OpenAI;
    const provider = new OpenAiChatProvider(client, new FixedClock(100), 'low');
    const events = await drain(provider.turn(input()));
    assert.deepEqual(
      events.filter((event) => event.type === 'reasoning'),
      [{ type: 'reasoning', content: 'Private scratchpad only.' }],
    );
    assert.equal(
      events.some((event) => event.type === 'text_delta'),
      false,
    );
    assert.equal(
      events.some((event) => event.type === 'tool_call'),
      false,
    );
    assert.equal(
      events.find((event) => event.type === 'done')?.type === 'done'
        ? events.find((event) => event.type === 'done')?.finishReason
        : undefined,
      'length',
    );
  });
});
