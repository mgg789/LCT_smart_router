import OpenAI from 'openai';
import { LlmCallError } from './retry.policy';

/**
 * Translates a raw `openai` SDK failure into the vocabulary `retry.policy.ts` owns.
 *
 * Shared by both OpenAI-SDK-based providers (`openai-chat.provider.ts` directly, and
 * `agents-sdk.provider.ts` through the same client via `setDefaultOpenAIClient`) so the
 * classification rules -- which status is a rate limit, which is a hard auth failure --
 * are stated exactly once.
 */
export function toLlmCallError(error: unknown): LlmCallError {
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError
  ) {
    return new LlmCallError(error.message, 'auth', { cause: error });
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new LlmCallError(error.message, 'rate_limit', { cause: error });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new LlmCallError(error.message, 'transport', { cause: error });
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const classification = typeof status === 'number' && status >= 500 ? 'server' : 'other';
    return new LlmCallError(error.message, classification, { cause: error });
  }
  return new LlmCallError(error instanceof Error ? error.message : String(error), 'transport', {
    cause: error,
  });
}
