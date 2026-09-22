import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import {
  EMPTY_PROVIDER_OUTCOME,
  type LlmStreamEvent,
  type LlmTurnInput,
  type ProviderOutcome,
} from './llm.types';
import { LlmProvider } from './llm-provider.port';

/**
 * Stands in when `LLM_PROVIDER=off`.
 *
 * Mirrors `NullRouterClient`: the chat surface must refuse honestly rather than pretend
 * to think. `isConfigured()` is false so the health probe reports `not_configured`
 * instead of `down`, and the rest of the application stays fully usable without it.
 */
@Injectable()
export class OffProvider extends LlmProvider {
  // Never actually surfaced: the runtime checks `isConfigured()` before starting a run.
  // Picking one concrete member is only to satisfy the port's type.
  readonly kind = 'openai_chat' as const;

  isConfigured(): boolean {
    return false;
  }

  turn(_input: LlmTurnInput): AsyncIterable<LlmStreamEvent> {
    throw SysError.notConfigured('AI-gateway');
  }

  lastOutcome(): ProviderOutcome {
    return EMPTY_PROVIDER_OUTCOME;
  }
}
