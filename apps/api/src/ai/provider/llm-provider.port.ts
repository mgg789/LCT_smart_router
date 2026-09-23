/**
 * How the AI runtime reaches a language model.
 *
 * The port exists so that the Agents SDK, a plain chat-completions loop and an offline
 * replay of recorded transcripts are interchangeable: choosing between them is a
 * configuration value, not a rewrite. That matters twice over here. The Agents SDK is
 * still a pre-1.0 package, so the product cannot be built on the assumption that its
 * surface holds; and the demo contour has to work with no network at all
 * (AGENTS.md section 4.7), which only an offline implementation can provide.
 *
 * An abstract class rather than an interface, so Nest can inject it by token -- the same
 * shape as `RouterClient` in `src/routing/router-gateway/router-client.port.ts`.
 *
 * The runtime, not the provider, owns tool execution. A provider surfaces the model's tool
 * calls and nothing more: it never runs one. Authorisation, the daily budget, the stop
 * signal and the journal therefore live in exactly one place regardless of which
 * implementation is configured, which is what makes replacing one contained.
 */

import type { AiProviderKind, LlmStreamEvent, LlmTurnInput, ProviderOutcome } from './llm.types';

export abstract class LlmProvider {
  /** Which implementation this is, recorded on every run for the journal. */
  abstract readonly kind: AiProviderKind;

  /**
   * Whether this deployment can actually call a model. False keeps the health probe at
   * `not_configured` and makes the chat surface refuse honestly instead of pretending.
   */
  abstract isConfigured(): boolean;

  /**
   * One model turn.
   *
   * Yields incremental events and finishes with exactly one `done`. Implementations must
   * honour `input.signal`: an aborted turn ends with `done` carrying `finishReason:
   * 'aborted'` rather than by throwing, because a run that was stopped is an outcome, not
   * a failure.
   *
   * A `tool_call` is emitted only once its arguments have been received in full and parse.
   * Partially streamed arguments are never executed (context/35 section 8), so buffering
   * fragments is the provider's job rather than the runtime's.
   */
  abstract turn(input: LlmTurnInput): AsyncIterable<LlmStreamEvent>;

  /**
   * What happened on the most recent real call.
   *
   * The health probe reads this instead of making a call of its own: a liveness check must
   * not spend the budget, and a probe every few seconds would spend a meaningful part of it.
   */
  abstract lastOutcome(): ProviderOutcome;
}
