/**
 * The shapes crossing the provider boundary.
 *
 * Deliberately smaller than any vendor SDK's own model: only what the runtime needs to
 * drive a turn, so that a second implementation is a translation job rather than a
 * re-derivation. Everything vendor-specific -- endpoint dialects, streaming frame shapes,
 * retry behaviour -- stays behind `LlmProvider`.
 */

export type AiProviderKind = 'agents' | 'openai_chat' | 'replay';

/** A tool as the model sees it. Parameters travel as JSON Schema, not as a zod object:
 *  the catalogue is authored with this workspace's zod 4, while the Agents SDK pins zod 3,
 *  so `z.toJSONSchema()` at the boundary keeps one dependency out of the other's way. */
export interface LlmToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parametersJsonSchema: Record<string, unknown>;
}

export type LlmMessage =
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      /**
       * Carried back verbatim on the next turn when the provider's thinking mode is used
       * together with tools. It is protocol material the provider requires, not text for
       * any interface, and it is never rendered.
       */
      readonly reasoningContent?: string;
      readonly toolCalls?: readonly LlmToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
    };

export interface LlmToolCall {
  /** The provider's own id, used only to bind a result back to its call. It is not a
   *  business idempotency key: a different model may issue a different id for the same
   *  intent, which is why prepared operations carry their own identity. */
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface LlmTurnInput {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolSpec[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** Aborting must end the turn with `done` / `aborted`, not with a throw. */
  readonly signal: AbortSignal;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'aborted';

export type LlmStreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning'; readonly content: string }
  /** Emitted only once the arguments are complete and parsed. */
  | { readonly type: 'tool_call'; readonly call: LlmToolCall }
  | {
      readonly type: 'done';
      readonly finishReason: LlmFinishReason;
      readonly usage: LlmUsage;
    };

/**
 * Cached result of the last real call, so health can be reported without paying for it.
 *
 * `authFailed` is separate from a failure count because a rejected credential is a
 * configuration fault that no amount of retrying fixes, and it must not be reported as a
 * degraded model.
 */
export interface ProviderOutcome {
  readonly lastOkAt: number | null;
  readonly lastFailureAt: number | null;
  readonly consecutiveFailures: number;
  readonly authFailed: boolean;
  readonly lastErrorMessage: string | null;
}

export const EMPTY_PROVIDER_OUTCOME: ProviderOutcome = {
  lastOkAt: null,
  lastFailureAt: null,
  consecutiveFailures: 0,
  authFailed: false,
  lastErrorMessage: null,
};
