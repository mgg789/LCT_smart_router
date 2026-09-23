import OpenAI from 'openai';

/**
 * Shared construction of the OpenAI-compatible client both live providers sit on top of.
 *
 * `maxRetries: 0` is not an oversight: the SDK has its own retry loop, and
 * `retry.policy.ts` is the single place that is allowed to decide whether a failed call
 * is retried. Leaving the SDK's retries on would multiply attempts behind that policy's
 * back and make `LLM_MAX_ATTEMPTS` a lie.
 *
 * Named for the default endpoint (DeepSeek) rather than for "openai" generically,
 * because the client itself is vendor-neutral -- any OpenAI-compatible `baseURL` works,
 * and the name should not suggest the official API is the only target.
 */
export interface DeepseekClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export function createDeepseekClient(options: DeepseekClientOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: 0,
  });
}
