import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Actor } from '../../auth/actor';
import { SysError } from '../../common/errors';

// Deliberately scoped to this API process: a restart invalidates pending approvals
// and asks the caller to reopen the action. No stale approval survives a deployment.
const signingKey = randomBytes(32);
const TTL_SEC = 900;

/** The exact version and bounds a person must approve; all times are epoch seconds. */
export interface WindowChange {
  requestId: string;
  version: number;
  previousStartAt: number;
  previousEndAt: number;
  windowStartAt: number;
  windowEndAt: number;
}

/** The common recovery discriminator; this challenge is not a final operation refusal. */
export function isWindowConfirmationRequired(error: unknown): error is SysError {
  return error instanceof SysError && error.details.kind === 'window_change_confirmation';
}

/** Requires an authenticated caller to echo a short-lived, exact-change confirmation. */
export function requireWindowConfirmation(actor: Actor, change: WindowChange): void {
  if (
    change.previousStartAt === change.windowStartAt &&
    change.previousEndAt === change.windowEndAt
  )
    return;
  const now = Math.floor(Date.now() / 1000);
  const sign = (expiresAt: number) =>
    createHmac('sha256', signingKey)
      .update(
        JSON.stringify([
          actor.kind,
          actor.id,
          change.requestId,
          change.version,
          change.previousStartAt,
          change.previousEndAt,
          change.windowStartAt,
          change.windowEndAt,
          expiresAt,
        ]),
      )
      .digest('hex');
  const [expiry, signature] = (actor.windowChangeConfirmation ?? '').split('.');
  const expiresAt = Number(expiry);
  if (
    actor.source !== 'ai_run' &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt >= now &&
    expiresAt <= now + TTL_SEC &&
    typeof signature === 'string' &&
    /^[a-f0-9]{64}$/.test(signature) &&
    timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(expiresAt), 'hex'))
  )
    return;
  const deadline = now + TTL_SEC;
  throw new SysError(
    'VALIDATION_FAILED',
    'Сдвиг временного окна требует подтверждения пользователя.',
    {
      details: {
        kind: 'window_change_confirmation',
        ...change,
        confirmation: `${deadline}.${sign(deadline)}`,
      },
    },
  );
}

/** AI must ask a human for these actions even when the model's safety check allows them. */
export function mayChangeRequestWindow(action: string, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const data = payload as Record<string, unknown>;
  return (
    (action === 'manual.decision.put' && data.kind === 'window') ||
    (action === 'request.update' &&
      (data.windowStartAt !== undefined || data.windowEndAt !== undefined)) ||
    (action === 'alert.resolve' &&
      (data.action === 'move_window' || data.action === 'reschedule')) ||
    action === 'request.reschedule'
  );
}
