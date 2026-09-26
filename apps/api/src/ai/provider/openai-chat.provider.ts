import { Injectable } from '@nestjs/common';
import type OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { Clock } from '../../common/time';
import {
  EMPTY_PROVIDER_OUTCOME,
  type LlmFinishReason,
  type LlmMessage,
  type LlmStreamEvent,
  type LlmToolSpec,
  type LlmTurnInput,
  type ProviderOutcome,
} from './llm.types';
import { LlmProvider } from './llm-provider.port';
import { toLlmCallError } from './openai-error.util';
import { createVisibleAnswerFilter } from './visible-answer';

/**
 * Plain `chat.completions` streaming loop, the fallback path that needs neither the
 * Agents SDK nor its tool-approval machinery.
 *
 * Tool-call arguments arrive as string fragments spread across many chunks; the port
 * requires a `tool_call` event only once the arguments are complete, so fragments are
 * buffered by their stream index and only parsed after the model signals the call is
 * finished (`finish_reason: 'tool_calls'`). Parsing after every fragment instead would
 * risk treating an in-progress prefix that happens to already be valid JSON as the
 * complete call.
 *
 * `reasoning_content` is a DeepSeek extension the official SDK types do not model; it is
 * read defensively off the delta rather than assumed present. It is never the reply.
 * DeepSeek thinks by default, and `max_tokens` covers the scratchpad and the answer
 * together, so a long monologue finishes with `length` and an empty `content`. Thinking
 * stays off on this path so the token budget is the answer the dispatcher sees.
 * A `<think>` span inside `content` is stripped before it is yielded.
 */
@Injectable()
export class OpenAiChatProvider extends LlmProvider {
  readonly kind = 'openai_chat' as const;

  private outcome: ProviderOutcome = EMPTY_PROVIDER_OUTCOME;

  constructor(
    private readonly client: OpenAI,
    private readonly clock: Clock,
  ) {
    super();
  }

  isConfigured(): boolean {
    return true;
  }

  async *turn(input: LlmTurnInput): AsyncIterable<LlmStreamEvent> {
    if (input.signal.aborted) {
      yield abortedEvent();
      return;
    }

    let stream: AsyncIterable<ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: input.model,
          messages: toChatMessages(input.system, input.messages, input.closing),
          ...(input.tools.length > 0 ? { tools: input.tools.map(toChatTool) } : {}),
          max_tokens: input.maxOutputTokens,
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: 'disabled' },
        } as ChatCompletionCreateParamsStreaming,
        { signal: input.signal },
      );
    } catch (error) {
      this.recordFailure(error);
      throw toLlmCallError(error);
    }

    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
    const visible = createVisibleAnswerFilter();
    let finishReason: LlmFinishReason = 'stop';
    let usage = { promptTokens: 0, completionTokens: 0 };

    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) {
          continue;
        }
        const reasoning = reasoningContentOf(choice.delta);
        if (reasoning) {
          yield { type: 'reasoning', content: reasoning };
        }
        if (choice.delta.content) {
          const text = visible.push(choice.delta.content);
          if (text.length > 0) {
            yield { type: 'text_delta', text };
          }
        }
        for (const fragment of choice.delta.tool_calls ?? []) {
          const existing = toolCallBuffers.get(fragment.index) ?? { id: '', name: '', args: '' };
          if (fragment.id) {
            existing.id = fragment.id;
          }
          if (fragment.function?.name) {
            existing.name = fragment.function.name;
          }
          if (fragment.function?.arguments) {
            existing.args += fragment.function.arguments;
          }
          toolCallBuffers.set(fragment.index, existing);
        }
        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }
      const tail = visible.finish();
      if (tail.length > 0) {
        yield { type: 'text_delta', text: tail };
      }
    } catch (error) {
      if (input.signal.aborted) {
        yield abortedEvent();
        this.recordOk();
        return;
      }
      this.recordFailure(error);
      throw toLlmCallError(error);
    }

    for (const buffered of toolCallBuffers.values()) {
      const parsed = tryParseJson(buffered.args);
      // Silently dropped when the model never finished the call or produced arguments
      // that do not parse: emitting a half-formed call would let the runtime execute on
      // arguments no one validated (context/35 section 8).
      if (parsed !== undefined && buffered.id && buffered.name) {
        yield {
          type: 'tool_call',
          call: { id: buffered.id, name: buffered.name, arguments: parsed },
        };
      }
    }

    yield { type: 'done', finishReason, usage };
    this.recordOk();
  }

  lastOutcome(): ProviderOutcome {
    return this.outcome;
  }

  private recordOk(): void {
    this.outcome = {
      lastOkAt: this.clock.nowSeconds(),
      lastFailureAt: this.outcome.lastFailureAt,
      consecutiveFailures: 0,
      authFailed: false,
      lastErrorMessage: null,
    };
  }

  private recordFailure(error: unknown): void {
    const wrapped = toLlmCallError(error);
    this.outcome = {
      lastOkAt: this.outcome.lastOkAt,
      lastFailureAt: this.clock.nowSeconds(),
      consecutiveFailures: this.outcome.consecutiveFailures + 1,
      authFailed: wrapped.classification === 'auth',
      lastErrorMessage: wrapped.message,
    };
  }
}

function toChatMessages(
  system: string,
  messages: readonly LlmMessage[],
  closing?: string,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }
          : {}),
      });
      continue;
    }
    out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
  }
  if (closing) {
    out.push({ role: 'system', content: closing });
  }
  return out;
}

function toChatTool(spec: LlmToolSpec): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parametersJsonSchema,
    },
  };
}

/** DeepSeek's `reasoning_content` field is not part of the official chunk type. */
function reasoningContentOf(delta: ChatCompletionChunk.Choice['delta']): string | null {
  const withExtra = delta as unknown as { reasoning_content?: string | null };
  return typeof withExtra.reasoning_content === 'string' && withExtra.reasoning_content.length > 0
    ? withExtra.reasoning_content
    : null;
}

function mapFinishReason(
  reason: NonNullable<ChatCompletionChunk.Choice['finish_reason']>,
): LlmFinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function abortedEvent(): LlmStreamEvent {
  return { type: 'done', finishReason: 'aborted', usage: { promptTokens: 0, completionTokens: 0 } };
}
