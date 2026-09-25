import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { NotificationCategory } from '../generated/prisma/client';
import type { Tx } from '../persistence';
import { redactPayload } from './smtp.helpers';

export interface NotificationIntentInput {
  readonly category: NotificationCategory;
  /**
   * Deduplication key of the business transition this letter belongs to.
   *
   * One letter per transition, not per read of a result: a new plan that repeats the same
   * assignment is not a new reason to write to the customer (context/36 section 10).
   */
  readonly businessEventKey: string;
  readonly recipientAccountId?: string | null;
  readonly recipientEmail?: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * In-app notices that must never become SMTP. `plan_rebuilt` and
 * `engineer_attention_required` stay on the dashboard; mailing them is spam.
 */
export const MAIL_DISABLED_CATEGORIES = new Set(['plan_rebuilt', 'engineer_attention_required']);

/**
 * Records what sys has decided to send.
 *
 * sys composes the letter; SMTP-gateway submits it. Until the external server
 * accepts the message the row stays `pending_submission` -- that is the honest
 * state, not a pretended success (context/42 DF-20).
 *
 * There is deliberately no `delivered` state anywhere in this model. Our control ends
 * when the mail server accepts a message; whether it reached a mailbox is outside it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  /**
   * Writes the intent inside the caller's transaction, so that a saved business change
   * cannot lose the letter it implies.
   *
   * Repeating the same business event is a no-op: the key is unique, and a retry of the
   * operation must not produce a second message to the customer.
   *
   * A recipient who silenced their letters stops event mail, but never a login code: a
   * way in must not be silenceable (card #65, 2026-09-20).
   *
   * `MAIL_DISABLED_CATEGORIES` are recorded as dashboard notices only — no intent row.
   */
  async record(tx: Tx, now: number, input: NotificationIntentInput): Promise<void> {
    if (MAIL_DISABLED_CATEGORIES.has(input.category)) {
      this.logger.log(`Mail disabled for ${input.category}; no intent recorded`);
      return;
    }
    const account =
      input.recipientAccountId === null || input.recipientAccountId === undefined
        ? null
        : await tx.account.findUnique({ where: { id: input.recipientAccountId } });
    const recipientEmail = input.recipientEmail ?? account?.email ?? null;
    if (!recipientEmail) {
      // Without a real address there is nothing to send. Recording an intent with an
      // invented recipient would be worse than recording none: context/41 section 10
      // requires real contact data before sending anything.
      this.logger.warn(`No recipient address for ${input.category}; no intent recorded`);
      return;
    }
    if (
      account !== null &&
      !account.mailNotificationsEnabled &&
      input.category !== 'account_login_code'
    ) {
      this.logger.log(`Recipient ${recipientEmail} silenced ${input.category}; no intent recorded`);
      return;
    }

    const existing = await tx.notificationIntent.findUnique({
      where: { businessEventKey: input.businessEventKey },
    });
    if (existing) {
      return;
    }

    await tx.notificationIntent.create({
      data: {
        category: input.category,
        businessEventKey: input.businessEventKey,
        recipientEmail,
        payload: input.payload as object,
        state: 'pending_submission',
        createdAt: BigInt(now),
      },
    });
  }

  /**
   * Redacts the login code out of every stale `pending_submission` intent.
   *
   * A code mail waiting for a transport is the only place a login code ever rests in
   * the clear (the stored verifier is a hash). Once the code's TTL is over no transport
   * will ever send it, so the payload loses the code right there -- a database dump
   * must not replay even an expired way in, and an SMTP-less contour must not keep
   * codes forever.
   */
  async redactStaleLoginCodePayloads(tx: Tx, now: number, ttlSec: number): Promise<number> {
    const stale = await tx.notificationIntent.findMany({
      where: {
        category: 'account_login_code',
        state: 'pending_submission',
        createdAt: { lt: BigInt(now - ttlSec) },
      },
      select: { id: true, payload: true },
    });
    let redacted = 0;
    for (const row of stale) {
      const payload = row.payload as Record<string, unknown> | null;
      if (!payload || !('code' in payload) || payload.code === '[redacted]') continue;
      const redactedPayload = redactPayload(payload) as Prisma.InputJsonValue;
      await tx.notificationIntent.update({
        where: { id: row.id },
        data: { payload: redactedPayload },
      });
      redacted += 1;
    }
    if (redacted > 0) {
      this.logger.log(`Redacted ${redacted} expired login-code payload(s)`);
    }
    return redacted;
  }
}
