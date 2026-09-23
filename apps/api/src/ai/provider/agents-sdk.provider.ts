import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  Agent,
  type AgentInputItem,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  type RunStreamEvent,
  type RunToolApprovalItem,
  run,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import type OpenAiClient from 'openai';
import { Clock } from '../../common/time';
import {
  EMPTY_PROVIDER_OUTCOME,
  type LlmFinishReason,
  type LlmMessage,
  type LlmStreamEvent,
  type LlmToolCall,
  type LlmToolSpec,
  type LlmTurnInput,
  type ProviderOutcome,
} from './llm.types';
import { LlmProvider } from './llm-provider.port';
import { toLlmCallError } from './openai-error.util';

/**
 * Process-wide switches (`setDefaultOpenAIClient` and friends) are registered once, not
 * once per instance -- Nest could otherwise construct this provider twice (primary and
 * fallback both set to `agents`) and have the second registration fight the first over
 * which client and API dialect are the default.
 */
let registeredClient: OpenAiClient | null = null;

/**
 * Runs one turn through `@openai/agents`, the Agents SDK the product is not yet willing
 * to commit its retry and tool-execution behaviour to (see the doc comment on
 * `LlmProvider`).
 *
 * The SDK's own `Runner` normally executes a tool the moment the model calls it. That is
 * exactly the behaviour this class opts out of: every declared tool is created with
 * `needsApproval: true`, which makes the SDK stop and report an *interruption* instead of
 * invoking anything. A model turn therefore always ends after exactly one call to the
 * model -- `maxTurns: 1` makes that a hard guarantee rather than an assumption -- and any
 * tool the model wants to call comes back to the runtime as a `tool_call` event, to be
 * authorised, journalled and executed the same way regardless of which provider is
 * configured.
 *
 * Tool parameters travel as plain JSON Schema (`strict: false`, a hand-built
 * `JsonObjectSchemaNonStrict`), never as a zod schema: the catalogue is authored with
 * this workspace's zod 4 and the port already settled on JSON Schema at the boundary for
 * exactly this reason (see `llm.types.ts`).
 */
@Injectable()
export class AgentsSdkProvider extends LlmProvider {
  readonly kind = 'agents' as const;

  private outcome: ProviderOutcome = EMPTY_PROVIDER_OUTCOME;

  constructor(
    client: OpenAiClient,
    private readonly clock: Clock,
  ) {
    super();
    if (registeredClient !== client) {
      setDefaultOpenAIClient(client);
      setOpenAIAPI('chat_completions');
      setTracingDisabled(true);
      registeredClient = client;
    }
  }

  isConfigured(): boolean {
    return true;
  }

  async *turn(input: LlmTurnInput): AsyncIterable<LlmStreamEvent> {
    if (input.signal.aborted) {
      yield abortedEvent();
      return;
    }

    const agent = new Agent({
      name: 'field-engineer-routing-assistant',
      instructions: input.system,
      model: input.model,
      tools: input.tools.map(toApprovalTool),
    });

    let streamed: Awaited<ReturnType<typeof run>>;
    try {
      streamed = await run(agent, toAgentInput(input.messages), {
        stream: true,
        signal: input.signal,
        maxTurns: 1,
      });
    } catch (error) {
      this.recordFailure(error);
      throw toLlmCallError(error);
    }

    try {
      for await (const event of streamed) {
        const mapped = mapStreamEvent(event);
        if (mapped) {
          yield mapped;
        }
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

    if (streamed.error) {
      if (input.signal.aborted) {
        yield abortedEvent();
        this.recordOk();
        return;
      }
      this.recordFailure(streamed.error);
      throw toLlmCallError(streamed.error);
    }

    const interruptions = streamed.interruptions ?? [];
    for (const interruption of interruptions) {
      const call = toToolCall(interruption);
      if (call) {
        yield { type: 'tool_call', call };
      }
    }

    const finishReason: LlmFinishReason = interruptions.length > 0 ? 'tool_calls' : 'stop';
    const usage = streamed.runContext.usage;
    yield {
      type: 'done',
      finishReason,
      usage: { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens },
    };
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

interface ToolParametersSchema {
  readonly type: 'object';
  readonly properties: Record<string, Record<string, unknown>>;
  readonly required: string[];
  readonly additionalProperties: true;
  readonly description?: string;
}

function toNonStrictSchema(schema: Record<string, unknown>): ToolParametersSchema {
  const properties = isRecord(schema.properties)
    ? (schema.properties as Record<string, Record<string, unknown>>)
    : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const description = typeof schema.description === 'string' ? schema.description : undefined;
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: true,
    ...(description === undefined ? {} : { description }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Declares the tool's shape and immediately refuses to run it: see the class doc
 *  comment for why execution never reaches this callback. */
function toApprovalTool(spec: LlmToolSpec): ReturnType<typeof tool> {
  return tool({
    name: spec.name,
    description: spec.description,
    parameters: toNonStrictSchema(spec.parametersJsonSchema),
    strict: false,
    needsApproval: true,
    execute: () => {
      throw new Error(`Tool "${spec.name}" is owned by the runtime and must never execute here`);
    },
  });
}

function toAgentInput(messages: readonly LlmMessage[]): AgentInputItem[] {
  const items: AgentInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      items.push({ type: 'message', role: 'user', content: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) {
        items.push({
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: message.content }],
        });
      }
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: 'function_call',
          callId: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
          status: 'completed',
        });
      }
      continue;
    }
    items.push({
      type: 'function_call_result',
      name: message.name,
      callId: message.toolCallId,
      status: 'completed',
      output: message.content,
    });
  }
  return items;
}

function mapStreamEvent(event: RunStreamEvent): LlmStreamEvent | null {
  if (event instanceof RunRawModelStreamEvent && event.data.type === 'output_text_delta') {
    return { type: 'text_delta', text: event.data.delta };
  }
  if (event instanceof RunItemStreamEvent && event.name === 'reasoning_item_created') {
    const item = event.item;
    if (item.type === 'reasoning_item') {
      const text = item.rawItem.content.map((part) => part.text).join('');
      if (text) {
        return { type: 'reasoning', content: text };
      }
    }
  }
  return null;
}

function toToolCall(item: RunToolApprovalItem): LlmToolCall | null {
  const name = item.name;
  if (!name) {
    return null;
  }
  const argumentsText = item.arguments;
  const parsedArguments = argumentsText ? tryParseJson(argumentsText) : {};
  if (parsedArguments === undefined) {
    return null;
  }
  const id = 'callId' in item.rawItem ? item.rawItem.callId : randomUUID();
  return { id, name, arguments: parsedArguments };
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
