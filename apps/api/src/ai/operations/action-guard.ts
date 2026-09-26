import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../persistence';
import { RouterClient } from '../../routing/router-gateway';
import { storedGuardLine } from '../../orchestrator/simulator';
import type { AiPreviewRow } from '../runtime/ai-event.types';

/**
 * Whether System one considers a prepared dispatcher write safe to apply at once.
 *
 * `null` means the guard did not answer. That is a refusal, not a pass: a missing
 * check must not apply a write on its own.
 */
export function guardAllows(noul: number | null): boolean {
  return noul !== null && noul >= 0.5;
}

/**
 * System one check for a fix-mode card, shaped like Laya's `guard_questions`:
 * one `noul` over a short state, with explicit false/true criteria.
 *
 * A high score means the write is an ordinary field-routing change. Anything else,
 * including a failed call, stays for the dispatcher.
 */
@Injectable()
export class ActionGuardService {
  private readonly logger = new Logger(ActionGuardService.name);

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly router?: RouterClient,
  ) {}

  async allows(action: string, preview: readonly AiPreviewRow[]): Promise<boolean> {
    const lines = preview.map((row) => `${row.label}: ${row.value}`).join('\n');
    const facts = await this.storedFacts(action);
    const state = `action: ${action}\n${lines}${facts ? `\n${facts}` : ''}`.slice(0, 6_000);
    return this.noul(state);
  }

  /**
   * Same check as {@link allows}, for an agent that has not applied the write yet.
   * The caller supplies the before/after text. A failed call is `risk`.
   */
  async review(action: string, context: string, delta: string): Promise<'allowed' | 'risk'> {
    const state = `action: ${action}\nконтекст: ${context}\n${delta}`.slice(0, 6_000);
    return (await this.noul(state)) ? 'allowed' : 'risk';
  }

  /** True only when System one scores the write as an ordinary change. */
  private async noul(state: string): Promise<boolean> {
    const raw = (process.env.JEV_API_URL ?? 'http://host.docker.internal:12444').replace(/\/$/, '');
    // Operator-configured local service; the only check that makes sense is the
    // scheme one -- a private-network address is exactly what this endpoint is.
    try {
      const scheme = new URL(raw).protocol;
      if (scheme !== 'http:' && scheme !== 'https:') return false;
    } catch {
      return false;
    }
    const base = raw;
    try {
      const response = await fetch(`${base}/v1/noul`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          state,
          question:
            'Is this dispatcher write safe to apply immediately, without asking a person first?',
          criteria: {
            false: 'risky: broad, hard to undo, or not a routine field-routing change',
            true: 'safe: an ordinary change a dispatcher would apply without a second look',
          },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { noul?: unknown };
      const noul = typeof body.noul === 'number' ? body.noul : null;
      return guardAllows(noul);
    } catch (error) {
      this.logger.warn(
        `Action guard failed closed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return false;
    }
  }

  /** Stored what-if numbers only. A missing row leaves the guard text unchanged. */
  private async storedFacts(action: string): Promise<string> {
    if (!this.prisma || !this.router?.isConfigured()) return '';
    if (
      action !== 'policy.select' &&
      action !== 'move_window' &&
      action !== 'request.update' &&
      action !== 'router.technical-settings.replace' &&
      action !== 'engineer.set_availability'
    ) {
      return '';
    }
    try {
      const [current, contextVersion] = await Promise.all([
        this.prisma.routingCurrent.findUnique({
          where: { id: 'singleton' },
          include: { snapshot: true },
        }),
        this.router.getActiveContextVersion(),
      ]);
      if (!current || !contextVersion) return '';
      return await storedGuardLine(
        this.prisma,
        current.snapshot.inputHash,
        contextVersion,
        action,
      );
    } catch (error) {
      this.logger.warn(
        `Stored simulation was not added: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      return '';
    }
  }
}
