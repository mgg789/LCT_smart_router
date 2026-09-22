import { Injectable } from '@nestjs/common';
import { bigIntToSeconds, Clock } from '../../common/time';
import type {
  AiConversation,
  AiMessage,
  AiMessageAuthor,
  AiMessageKind,
  AiRoleProfile,
  Role,
} from '../../generated/prisma/client';
import type { Tx } from '../../persistence';
import { PrismaService, UnitOfWork } from '../../persistence';
import type { LlmMessage } from '../provider';

export interface GetOrCreateConversationInput {
  readonly accountId: string;
  readonly role: Role;
  readonly roleProfile: AiRoleProfile;
  /** Which request/engineer/alert the dialogue was opened about, if any. */
  readonly contextRef?: Record<string, unknown> | null;
}

export interface AppendMessageInput {
  readonly author: AiMessageAuthor;
  readonly kind?: AiMessageKind;
  readonly text: string;
  readonly actions?: readonly unknown[];
  readonly runId?: string | null;
  readonly operationId?: string | null;
  readonly authorAccountId?: string | null;
}

/**
 * Get-or-create per actor+lane, per-conversation message ordering, and the read paths
 * both the controller and the runtime need.
 *
 * `roleProfile` (not the bare `Role`) is the lane key: a dispatcher's read-only helper
 * chat and the one where they asked the assistant to change something are deliberately
 * separate conversations, because the tool catalogue and the documents visible to each
 * are different (schema.prisma's own comment on `AiRoleProfile`).
 */
@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Finds the open conversation for this account+lane, or creates one.
   *
   * Two tabs opening the chat at the same moment must not create two rows for the same
   * lane -- there would then be two different histories and budgets for what the account
   * experiences as one chat. An advisory lock keyed by account+lane serialises the
   * find-or-create without taking a row lock on a table that, for a brand-new account,
   * has no row yet to lock.
   */
  async getOrCreate(input: GetOrCreateConversationInput): Promise<AiConversation> {
    return this.uow.run(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-conv:${input.accountId}:${input.roleProfile}`}))`;
      const existing = await tx.aiConversation.findFirst({
        where: { accountId: input.accountId, roleProfile: input.roleProfile, closedAt: null },
        orderBy: { lastMessageAt: 'desc' },
      });
      if (existing) {
        return existing;
      }
      const now = BigInt(this.clock.nowSeconds());
      return tx.aiConversation.create({
        data: {
          accountId: input.accountId,
          role: input.role,
          roleProfile: input.roleProfile,
          ...(input.contextRef ? { contextRef: input.contextRef as object } : {}),
          createdAt: now,
          updatedAt: now,
          lastMessageAt: now,
        },
      });
    });
  }

  async byId(conversationId: string): Promise<AiConversation | null> {
    return this.prisma.aiConversation.findUnique({ where: { id: conversationId } });
  }

  /**
   * Appends one message under a per-conversation sequence.
   *
   * Locks the conversation row for the transaction's lifetime before computing the next
   * `seq`: two concurrent submissions to the same conversation (a double-click, or a
   * retried request racing the original) must not compute the same "next" number from
   * the same `MAX(seq)` read.
   */
  async appendMessage(
    tx: Tx,
    conversationId: string,
    now: number,
    input: AppendMessageInput,
  ): Promise<AiMessage> {
    await tx.$queryRaw`SELECT id FROM ai_conversations WHERE id = ${conversationId} FOR UPDATE`;
    const last = await tx.aiMessage.aggregate({ where: { conversationId }, _max: { seq: true } });
    const seq = (last._max.seq ?? 0) + 1;
    const created = await tx.aiMessage.create({
      data: {
        conversationId,
        seq,
        author: input.author,
        kind: input.kind ?? 'text',
        text: input.text,
        actions: (input.actions ?? []) as object,
        runId: input.runId ?? null,
        operationId: input.operationId ?? null,
        authorAccountId: input.authorAccountId ?? null,
        createdAt: BigInt(now),
      },
    });
    await tx.aiConversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: BigInt(now), updatedAt: BigInt(now) },
    });
    return created;
  }

  /** The tail of a conversation after `afterSeq`, for the same catch-up read the run
   *  events endpoint offers. */
  async listMessages(conversationId: string, afterSeq: number): Promise<AiMessage[]> {
    return this.prisma.aiMessage.findMany({
      where: { conversationId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
    });
  }

  /**
   * The most recent `limit` messages, oldest first, translated into the provider's own
   * message shape.
   *
   * Only `user` and `assistant`/`dispatcher` turns are conversation content as far as
   * the model is concerned; `system` rows are operational annotations (e.g. a mode
   * change) and are not replayed into the prompt.
   */
  async historyWindow(conversationId: string, limit: number): Promise<LlmMessage[]> {
    const recent = await this.prisma.aiMessage.findMany({
      where: { conversationId, author: { in: ['user', 'assistant', 'dispatcher'] } },
      orderBy: { seq: 'desc' },
      take: limit,
    });
    return recent
      .slice()
      .reverse()
      .map(
        (message): LlmMessage =>
          message.author === 'user'
            ? { role: 'user', content: message.text }
            : { role: 'assistant', content: message.text },
      );
  }

  /** Unix-seconds `lastMessageAt` for callers outside this module that only have the
   *  Prisma row's raw BigInt. */
  static lastMessageAtSeconds(conversation: AiConversation): number {
    return bigIntToSeconds(conversation.lastMessageAt);
  }
}
