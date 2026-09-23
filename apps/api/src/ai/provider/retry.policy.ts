import type { AiProviderKind, LlmStreamEvent, LlmTurnInput } from './llm.types';
import type { LlmProvider } from './llm-provider.port';

/**
 * The single owner of "how many times does the runtime try to reach a model".
 *
 * `LLM_MAX_ATTEMPTS` is a per-run budget shared by primary retries **and** the one
 * allowed fallback hop -- it is not "N retries of the primary, then N more of the
 * fallback". Keeping that arithmetic in exactly one place is what stops a flaky primary
 * and a flaky fallback from multiplying into an unbounded retry storm against a model
 * endpoint that is already struggling.
 */

/** How a failed call was classified, so the policy can decide without re-inspecting the
 *  vendor SDK's exception hierarchy a second time. */
export type LlmCallClassification = 'transport' | 'rate_limit' | 'server' | 'auth' | 'other';

/**
 * Raised by a provider once it has translated a vendor-specific failure into the
 * vocabulary this policy understands. Providers throw this instead of letting the raw
 * SDK error escape, so the policy never has to know which vendor SDK is in play.
 */
export class LlmCallError extends Error {
  readonly classification: LlmCallClassification;

  constructor(
    message: string,
    classification: LlmCallClassification,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmCallError';
    this.classification = classification;
  }
}

/** Narrows any thrown value to a classification; an error a provider did not wrap is
 *  treated as `other`, i.e. not retried -- an unrecognised failure is not safe to assume
 *  transient. */
export function classify(error: unknown): LlmCallClassification {
  return error instanceof LlmCallError ? error.classification : 'other';
}

export interface RetryDecisionInput {
  readonly classification: LlmCallClassification;
  /** Attempts already made, including the one that just failed. */
  readonly attemptsSoFar: number;
  readonly maxAttempts: number;
  readonly hasFallback: boolean;
  readonly usedFallback: boolean;
  /** True once any content (text, reasoning or a tool call) has already reached the
   *  client for this turn. */
  readonly startedStreaming: boolean;
  readonly stopRequested: boolean;
}

export type RetryDecision = { readonly action: 'retry_same' | 'retry_fallback' | 'give_up' };

/**
 * Pure decision function, deliberately separated from the streaming loop below so the
 * rules can be asserted without simulating a fake provider.
 *
 * Only `transport`, `rate_limit` and `server` are retryable at all. `auth` never is --
 * a rejected credential does not heal by trying again -- and neither is a run whose stop
 * flag is already set: a human asked this to end, and retrying (least of all against a
 * fallback the human never agreed to spend budget on) would ignore that.
 *
 * Once any content has streamed, the turn cannot be retried even if the failure itself
 * would otherwise qualify: replaying it would either duplicate text the client already
 * rendered or contradict it, and the contract in ai-event.types.ts promises the client
 * never has to guess which partial text to trust.
 *
 * When a fallback exists, exactly one of the attempts in the budget is reserved for it,
 * so `LLM_MAX_ATTEMPTS` retries of the primary never crowd the fallback hop out.
 */
export function decideRetry(input: RetryDecisionInput): RetryDecision {
  if (input.stopRequested || input.startedStreaming) {
    return { action: 'give_up' };
  }
  if (input.classification === 'auth' || input.classification === 'other') {
    return { action: 'give_up' };
  }
  if (input.attemptsSoFar >= input.maxAttempts) {
    return { action: 'give_up' };
  }
  const reserveForFallback = input.hasFallback && !input.usedFallback ? 1 : 0;
  const primaryBudget = input.maxAttempts - reserveForFallback;
  if (!input.usedFallback && input.attemptsSoFar < primaryBudget) {
    return { action: 'retry_same' };
  }
  if (input.hasFallback && !input.usedFallback) {
    return { action: 'retry_fallback' };
  }
  return { action: 'give_up' };
}

/** Populated by {@link runProviderTurn} once the whole attempt sequence (primary retries
 *  plus, at most, one fallback hop) has produced a result -- read it only after the
 *  `for await` loop over the generator has finished. */
export interface RetryRunResult {
  providerKind: AiProviderKind;
  usedFallback: boolean;
  attempts: number;
}

/**
 * Runs one logical model turn under the policy above, forwarding every stream event as
 * it arrives instead of buffering the whole turn -- the SSE transport has to stay live
 * while the model is still thinking. A retry or fallback hop is invisible to the caller:
 * it just sees one continuous stream, unless a failure lands after content has already
 * streamed, in which case it propagates so the run can end with a truthful terminal
 * `error` event rather than silently resending a corrupted transcript.
 */
export async function* runProviderTurn(
  input: LlmTurnInput,
  primary: LlmProvider,
  fallback: LlmProvider | null,
  maxAttempts: number,
  result: { current: RetryRunResult },
): AsyncGenerator<LlmStreamEvent, void, void> {
  let attempts = 0;
  let usedFallback = false;
  let provider = primary;

  for (;;) {
    attempts += 1;
    let startedStreaming = false;
    try {
      for await (const event of provider.turn(input)) {
        if (event.type !== 'done') {
          startedStreaming = true;
        }
        yield event;
      }
      result.current = { providerKind: provider.kind, usedFallback, attempts };
      return;
    } catch (error) {
      const decision = decideRetry({
        classification: classify(error),
        attemptsSoFar: attempts,
        maxAttempts,
        hasFallback: fallback?.isConfigured() ?? false,
        usedFallback,
        startedStreaming,
        stopRequested: input.signal.aborted,
      });
      if (decision.action === 'give_up') {
        throw error;
      }
      if (decision.action === 'retry_fallback' && fallback) {
        provider = fallback;
        usedFallback = true;
      }
      // 'retry_same' falls through and loops again against the same provider.
    }
  }
}
