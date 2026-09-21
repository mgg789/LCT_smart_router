import { Injectable, Logger } from '@nestjs/common';
import type { NotificationCategory } from '../generated/prisma/client';
import type { Tx } from '../persistence';

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
   */
  async record(tx: Tx, now: number, input: NotificationIntentInput): Promise<void> {
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
}
