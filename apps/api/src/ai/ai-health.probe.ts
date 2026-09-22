import { Injectable } from '@nestjs/common';
import type { HealthProbe, ServiceHealth } from '../common/health';
import { LlmProvider } from './provider';

/**
 * AI is never a required dependency, the same as Router and SMTP: the rest of the
 * product is fully usable without a model (context/43 section 11.3).
 *
 * Reads `lastOutcome()` rather than calling the provider: a liveness check that spends
 * the daily budget on every poll would be its own kind of outage.
 */
@Injectable()
export class AiHealthProbe implements HealthProbe {
  readonly required = false;

  constructor(private readonly provider: LlmProvider) {}

  check(): ServiceHealth {
    if (!this.provider.isConfigured()) {
      return { status: 'not_configured', detail: 'AI-gateway has no provider configured' };
    }
    const outcome = this.provider.lastOutcome();
    if (outcome.authFailed) {
      return { status: 'down', detail: outcome.lastErrorMessage ?? 'authentication failed' };
    }
    if (outcome.consecutiveFailures >= 3) {
      return { status: 'down', detail: outcome.lastErrorMessage ?? 'provider unreachable' };
    }
    if (outcome.consecutiveFailures > 0) {
      return { status: 'degraded', detail: outcome.lastErrorMessage ?? 'recent call failed' };
    }
    return {
      status: 'ok',
      detail: outcome.lastOkAt ? `last ok at ${outcome.lastOkAt}` : 'configured, no calls yet',
    };
  }
}
