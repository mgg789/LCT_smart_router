import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { bigIntToSeconds, Clock } from '../../common/time';
import type {
  AiAssistMode,
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
  /** Used only when a conversation is created; an existing one keeps the title it has,
   *  so reopening a chat never renames a dialogue under the person reading it. */
  readonly title?: string | null;
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
    return this.uow.run(async (tx) => this.getOrCreateInTx(tx, input));
  }

  /**
   * The same find-or-create, joined to a transaction the caller already owns.
   *
   * A dispatcher opening a chat with a client has to create that client's conversation,
   * the handover and the opening message in one unit, so it cannot call
   * {@link getOrCreate} -- that would open a second transaction, and the advisory lock it
   * takes there would sit behind row locks held by the first one. Same lock, same
   * predicate, one transaction.
   */
  async getOrCreateInTx(tx: Tx, input: GetOrCreateConversationInput): Promise<AiConversation> {
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
        ...(input.title ? { title: input.title } : {}),
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now,
        // The row's lane is what the chat switch reads. The schema default is `help`,
        // so a fix-mode open has to say so or the switch flips back after a clear.
        ...(input.roleProfile === 'dispatcher_fix'
          ? { assistMode: 'fix' as const }
          : input.roleProfile === 'dispatcher_readonly'
            ? { assistMode: 'help' as const }
            : {}),
      },
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

  /**
   * Moves the open dispatcher dialogue into the other lane without opening a second chat.
   * The global flag and this row stay the same value, so the next turn's tool list matches
   * the switch the dispatcher just set.
   */
  async setDispatcherAssistMode(
    accountId: string,
    conversationId: string,
    mode: AiAssistMode,
    now: number,
  ): Promise<AiConversation> {
    const row = await this.ownedOpen(accountId, conversationId);
    return this.prisma.aiConversation.update({
      where: { id: row.id },
      data: {
        assistMode: mode,
        roleProfile: mode === 'fix' ? 'dispatcher_fix' : 'dispatcher_readonly',
        updatedAt: BigInt(now),
      },
    });
  }

  /**
   * Closes every still-open dialogue in one lane.
   *
   * Clear archives the dialogue the dispatcher is looking at, then asks for a new one.
   * `getOrCreate` would otherwise hand back a sibling that was already open in the same
   * lane, and the chat would not look empty.
   */
  async closeOpenLane(accountId: string, roleProfile: AiRoleProfile, now: number): Promise<void> {
    await this.prisma.aiConversation.updateMany({
      where: { accountId, roleProfile, closedAt: null },
      data: { closedAt: BigInt(now), updatedAt: BigInt(now) },
    });
  }

  /** Archives the dialogue. The next open starts empty; the old messages stay in the row. */
  async closeForAccount(
    accountId: string,
    conversationId: string,
    now: number,
  ): Promise<AiConversation> {
    const row = await this.ownedOpen(accountId, conversationId);
    return this.prisma.aiConversation.update({
      where: { id: row.id },
      data: { closedAt: BigInt(now), updatedAt: BigInt(now) },
    });
  }

  private async ownedOpen(accountId: string, conversationId: string): Promise<AiConversation> {
    const row = await this.prisma.aiConversation.findUnique({ where: { id: conversationId } });
    if (!row || row.accountId !== accountId) {
      throw SysError.notFound('Conversation', { conversationId });
    }
    if (row.closedAt !== null) {
      throw new SysError('VALIDATION_FAILED', 'This conversation is already closed', {
        details: { conversationId },
      });
    }
    return row;
  }

  /** Unix-seconds `lastMessageAt` for callers outside this module that only have the
   *  Prisma row's raw BigInt. */
  static lastMessageAtSeconds(conversation: AiConversation): number {
    return bigIntToSeconds(conversation.lastMessageAt);
  }
}
