import { Injectable, Logger } from '@nestjs/common';
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

  async allows(action: string, preview: readonly AiPreviewRow[]): Promise<boolean> {
    const raw = (process.env.JEV_API_URL ?? 'http://host.docker.internal:12444').replace(
      /\/$/,
      '',
    );
    // Operator-configured local service; the only check that makes sense is the
    // scheme one -- a private-network address is exactly what this endpoint is.
    try {
      const scheme = new URL(raw).protocol;
      if (scheme !== 'http:' && scheme !== 'https:') return false;
    } catch {
      return false;
    }
    const base = raw;
    const lines = preview.map((row) => `${row.label}: ${row.value}`).join('\n');
    const state = `action: ${action}\n${lines}`.slice(0, 6_000);
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
}
