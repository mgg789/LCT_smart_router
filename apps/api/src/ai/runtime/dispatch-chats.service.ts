import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { AiConversation, AiHandoff, AiMessage } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../persistence';
import { ConversationService } from './conversation.service';

/** One handed-over dialogue, with the fields the «Чаты» page needs: raw Prisma rows, not
 *  yet converted to the HTTP view (`toDispatchChatView` in `src/api/dispatch-chat-view.ts`
 *  owns the `bigint` boundary, the same split `ai-view.ts` already keeps). */
export interface DispatchChatRow {
  readonly handoff: AiHandoff;
  readonly conversation: AiConversation;
  readonly messages: readonly AiMessage[];
}

/**
 * The dispatcher side of DF-19: the list of dialogues currently handed to a human, a
 * human's own reply into one of them, and ending a handover.
 *
 * Every write here locks the conversation row first (`SELECT ... FOR UPDATE`, the same
 * idiom `ConversationService.appendMessage` uses) before reading `mode`/the open handoff,
 * so a reply and a concurrent `finish` on the same conversation cannot interleave: whichever
 * transaction acquires the lock first decides the outcome the other one observes.
 */
@Injectable()
export class DispatchChatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
  ) {}

  /** Every conversation currently in `dispatcher` mode, newest handover first, each with
   *  its open handoff and its full message history. The partial unique index on
   *  `ai_handoffs` (one non-closed row per conversation) is why "the open handoff" is
   *  never ambiguous here. */
  async listActive(): Promise<DispatchChatRow[]> {
    const handoffs = await this.prisma.aiHandoff.findMany({
      where: { state: { not: 'closed' }, conversation: { mode: 'dispatcher' } },
      include: { conversation: true },
      orderBy: { createdAt: 'desc' },
    });
    if (handoffs.length === 0) {
      return [];
    }
    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId: { in: handoffs.map((handoff) => handoff.conversationId) } },
      orderBy: { seq: 'asc' },
    });
    const byConversation = new Map<string, AiMessage[]>();
    for (const message of messages) {
      const list = byConversation.get(message.conversationId);
      if (list) {
        list.push(message);
      } else {
        byConversation.set(message.conversationId, [message]);
      }
    }
    return handoffs.map(({ conversation, ...handoff }) => ({
      handoff,
      conversation,
      messages: byConversation.get(handoff.conversationId) ?? [],
    }));
  }

  /**
   * Appends the dispatcher's own reply. Starts no run and reserves no budget -- a human
   * answering is not a model call (context/36 section 9.5).
   *
   * The first reply into a `waiting` handoff flips it to `answered` and stamps
   * `firstReplyAt`; a later reply leaves both alone (the `updateMany` below only ever
   * matches the still-`waiting` row), which is what lets the list tell "nobody has
   * answered yet" from "a human already did" without a false positive.
   */
  async reply(
    tx: Tx,
    now: number,
    conversationId: string,
    dispatcherAccountId: string,
    text: string,
  ): Promise<AiMessage> {
    const handoff = await this.lockOpenHandoff(tx, conversationId);
    const message = await this.conversations.appendMessage(tx, conversationId, now, {
      author: 'dispatcher',
      kind: 'text',
      text,
      authorAccountId: dispatcherAccountId,
    });
    if (handoff.state === 'waiting') {
      await tx.aiHandoff.updateMany({
        where: { id: handoff.id, state: 'waiting' },
        data: { state: 'answered', firstReplyAt: BigInt(now), version: { increment: 1 } },
      });
    }
    return message;
  }

  /**
   * Ends the handover: the handoff closes, the conversation returns to `ai` mode, and
   * nothing else moves. Message history is untouched, and no domain write this handover's
   * dispatcher already applied is reverted (context/36 section 9.3) -- this method never
   * touches any table but `ai_handoffs` and `ai_conversations`.
   */
  async finish(
    tx: Tx,
    now: number,
    conversationId: string,
    dispatcherAccountId: string,
  ): Promise<AiConversation> {
    const handoff = await this.lockOpenHandoff(tx, conversationId);
    await tx.aiHandoff.update({
      where: { id: handoff.id },
      data: {
        state: 'closed',
        closedAt: BigInt(now),
        closedByAccountId: dispatcherAccountId,
        version: { increment: 1 },
      },
    });
    return tx.aiConversation.update({
      where: { id: conversationId },
      data: { mode: 'ai', updatedAt: BigInt(now), version: { increment: 1 } },
    });
  }

  /**
   * Locks the conversation row, then returns its open handoff. Throws
   * `AI_HANDOFF_NOT_ACTIVE` for a conversation that was never escalated, or whose handover
   * already ended -- the one refusal both `reply` and `finish` share, so a late write from
   * a stale dispatcher tab is refused rather than quietly reopening a closed handover or
   * writing into an ordinary AI conversation.
   */
  private async lockOpenHandoff(tx: Tx, conversationId: string): Promise<AiHandoff> {
    await tx.$queryRaw`SELECT id FROM ai_conversations WHERE id = ${conversationId} FOR UPDATE`;
    const conversation = await tx.aiConversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      throw SysError.notFound('Conversation', { conversationId });
    }
    const handoff = await tx.aiHandoff.findFirst({
      where: { conversationId, state: { not: 'closed' } },
    });
    if (conversation.mode !== 'dispatcher' || !handoff) {
      throw new SysError(
        'AI_HANDOFF_NOT_ACTIVE',
        'This conversation is not currently handed to a dispatcher',
        { details: { conversationId } },
      );
    }
    return handoff;
  }
}
