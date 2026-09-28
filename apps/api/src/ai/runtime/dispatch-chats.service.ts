import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { reserveDisplayName } from '../../common/reserve-name';
import type {
  AiConversation,
  AiHandoff,
  AiMessage,
  AiRoleProfile,
  Role,
} from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../persistence';
import { ConversationService } from './conversation.service';

/**
 * One chat episode as the «Чаты» page needs it: the handover, the dialogue it belongs to,
 * the messages that fall inside it, and how many of them the dispatcher has not seen.
 *
 * Raw Prisma rows, not yet converted to the HTTP view -- `toDispatchChatView` in
 * `src/api/dispatch-chat-view.ts` owns the `bigint` boundary, the same split `ai-view.ts`
 * already keeps.
 */
export interface DispatchChatRow {
  readonly handoff: AiHandoff;
  readonly conversation: AiConversation;
  readonly messages: readonly AiMessage[];
  readonly unreadCount: number;
}

/**
 * Who the dispatcher wants to write to, named the way the dashboard already names them.
 *
 * Deliberately not an account id: every button that opens a chat sits next to a request
 * or an engineer, and resolving "which account is that" on the server means the browser
 * never has to learn one person's account id in order to message them.
 */
export type DispatchChatTarget =
  | { readonly kind: 'request'; readonly requestId: string }
  | { readonly kind: 'engineer'; readonly engineerId: string };

/** A chat opened (or re-opened) from the dashboard, with whatever was written into it as
 *  part of opening. `created` is false when a handover was already running. `handoff` is
 *  null when the dispatcher only looked: a handover starts with the first message. */
export interface OpenedDispatchChat {
  readonly handoff: AiHandoff | null;
  readonly conversation: AiConversation;
  readonly messages: readonly AiMessage[];
  readonly created: boolean;
}

/** One write into a chat, with the rows a caller needs to publish it on `ChatEventBus`. */
export interface DispatchChatWrite {
  readonly handoff: AiHandoff;
  readonly conversation: AiConversation;
  readonly message: AiMessage;
}

interface ResolvedTarget {
  readonly accountId: string;
  readonly role: Extract<Role, 'client' | 'engineer'>;
  readonly roleProfile: Extract<AiRoleProfile, 'client' | 'engineer'>;
  readonly title: string;
  readonly contextRef: Record<string, unknown>;
  readonly requestIds: string[];
  readonly engineerIds: string[];
}

/** How many finished chats the list carries. They are kept so the dispatcher can look
 *  back at what was agreed, not so the page can grow without limit. */
const DEFAULT_CLOSED_LIMIT = 30;

/**
 * Person-to-person chat between the dispatcher and a client or an engineer.
 *
 * Both directions are the same object. A dialogue is normally answered by the assistant;
 * when it is handed over -- because `call_dispatch_helper` decided a human was needed, or
 * because the dispatcher opened it from the dashboard -- an `AiHandoff` row exists, the
 * conversation's `mode` is `dispatcher`, and the assistant writes nothing until that row
 * is closed. Whether it is a client or an engineer on the other side is `conversation.role`
 * and changes nothing about the mechanism.
 *
 * Three rules hold throughout:
 *
 *   * **the handover row is the authority, not `mode`.** `mode` is what the assistant
 *     obeys; the row is what the dispatcher's list is built from. Ending a handover
 *     returns `mode` to `ai` and leaves the row where it is, which is why a finished chat
 *     keeps hanging in the list and a later escalation of the same dialogue opens a new
 *     row rather than reviving this one;
 *   * **every write locks the conversation first** (`SELECT ... FOR UPDATE`, the same
 *     idiom `ConversationService.appendMessage` uses) before reading `mode` or the open
 *     handover, so a reply and a concurrent `finish` cannot interleave: whichever
 *     transaction takes the lock first decides what the other one sees;
 *   * **nothing here publishes.** Callers publish on `ChatEventBus` after their
 *     transaction commits, using the rows these methods return -- see that class's own
 *     note on why announcing an uncommitted message is worse than announcing it late.
 */
@Injectable()
export class DispatchChatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationService,
  ) {}

  /**
   * One row per person. A live handover wins over a finished episode of the same
   * dialogue; otherwise the latest finished episode stands in, so ending a chat does
   * not invent a second row and does not drop the person out of the list.
   *
   * Closed episodes stay because ending a chat is not deleting it (context/36
   * section 9.3). The cap applies to how many finished conversations are loaded, not
   * to how the page sorts them: the screen orders by the last message.
   */
  async list(options: { readonly closedLimit?: number } = {}): Promise<DispatchChatRow[]> {
    const [open, closed] = await Promise.all([
      this.prisma.aiHandoff.findMany({
        where: { state: { not: 'closed' } },
        include: { conversation: true },
        orderBy: { conversation: { lastMessageAt: 'desc' } },
      }),
      this.prisma.aiHandoff.findMany({
        where: { state: 'closed' },
        include: { conversation: true },
        orderBy: { closedAt: 'desc' },
        take: options.closedLimit ?? DEFAULT_CLOSED_LIMIT,
      }),
    ]);
    const byConversation = new Map<string, (typeof open)[number]>();
    for (const handoff of open) byConversation.set(handoff.conversationId, handoff);
    for (const handoff of closed) {
      if (!byConversation.has(handoff.conversationId)) {
        byConversation.set(handoff.conversationId, handoff);
      }
    }
    return this.hydrate([...byConversation.values()]);
  }

  /** One chat episode by its handover id, for the response to a write that just changed
   *  it. */
  async byHandoffId(handoffId: string): Promise<DispatchChatRow | null> {
    const handoff = await this.prisma.aiHandoff.findUnique({
      where: { id: handoffId },
      include: { conversation: true },
    });
    if (!handoff) {
      return null;
    }
    const [row] = await this.hydrate([handoff]);
    return row ?? null;
  }

  /**
   * Opens a chat with the client of a request or with an engineer, from the dashboard.
   *
   * The dialogue is the person's *own* assistant conversation -- the same one they have
   * been talking to -- so everything they already said is in front of the dispatcher from
   * the first moment, and the answer they get arrives where they are already looking. A
   * second, parallel "dispatcher thread" would split one person's history in two.
   *
   * Pressing the button again while a handover is already running is not an error and
   * does not open a second one: it returns the running chat, which is what the dispatcher
   * meant by pressing it.
   */
  async openWithTarget(
    tx: Tx,
    now: number,
    dispatcherAccountId: string,
    target: DispatchChatTarget,
    text?: string,
  ): Promise<OpenedDispatchChat> {
    const resolved = await this.resolveTarget(tx, target);
    const conversation = await this.conversations.getOrCreateInTx(tx, {
      accountId: resolved.accountId,
      role: resolved.role,
      roleProfile: resolved.roleProfile,
      contextRef: resolved.contextRef,
      title: resolved.title,
    });
    await tx.$queryRaw`SELECT id FROM ai_conversations WHERE id = ${conversation.id} FOR UPDATE`;

    const written: AiMessage[] = [];
    let handoff = await tx.aiHandoff.findFirst({
      where: { conversationId: conversation.id, state: { not: 'closed' } },
    });
    const created = handoff === null;
    // Looking is not joining. The handover, and the switch that silences the assistant,
    // start only when the dispatcher actually sends a message.
    if (!handoff && (text === undefined || text.length === 0)) {
      return { handoff: null, conversation, messages: written, created: false };
    }

    if (!handoff) {
      const last = await tx.aiMessage.aggregate({
        where: { conversationId: conversation.id },
        _max: { seq: true },
      });
      const startSeq = last._max.seq ?? 0;
      handoff = await tx.aiHandoff.create({
        data: {
          conversationId: conversation.id,
          requestedByAccountId: dispatcherAccountId,
          actorRole: resolved.role,
          initiatedBy: 'dispatcher',
          requestIds: resolved.requestIds,
          engineerIds: resolved.engineerIds,
          // Nobody is waiting on a dispatcher in a chat the dispatcher just started, so
          // this never enters the "needs an answer" queue on its own account. It moves to
          // `waiting` the moment the other side writes back and no reply has followed.
          state: 'answered',
          // The dispatcher chose to open this chat; the history above it is context they
          // are about to read, not a backlog to badge them about. Only what arrives from
          // here on counts as unread.
          dispatcherLastReadSeq: startSeq,
          startSeq,
          createdAt: BigInt(now),
        },
      });
      await tx.aiConversation.updateMany({
        where: { id: conversation.id, mode: 'ai' },
        data: { mode: 'dispatcher', updatedAt: BigInt(now), version: { increment: 1 } },
      });
    }

    if (text !== undefined && text.length > 0) {
      const message = await this.conversations.appendMessage(tx, conversation.id, now, {
        author: 'dispatcher',
        kind: 'text',
        text,
        authorAccountId: dispatcherAccountId,
      });
      written.push(message);
      await tx.aiHandoff.update({
        where: { id: handoff.id },
        data: {
          state: 'answered',
          firstReplyAt: handoff.firstReplyAt ?? BigInt(now),
          dispatcherLastReadSeq: message.seq,
          version: { increment: 1 },
        },
      });
    }

    return {
      ...(await this.reread(tx, handoff.id, conversation.id)),
      messages: written,
      created,
    };
  }

  /**
   * Appends the dispatcher's own reply. Starts no run and reserves no budget -- a human
   * answering is not a model call (context/36 section 9.5).
   *
   * Replying is also an acknowledgement: the read cursor moves to this message, so the
   * unread badge clears without a separate call, and `firstReplyAt` is stamped once and
   * never revised, so "how long did the first answer take" stays answerable after a long
   * conversation.
   */
  async reply(
    tx: Tx,
    now: number,
    conversationId: string,
    dispatcherAccountId: string,
    text: string,
  ): Promise<DispatchChatWrite> {
    const open = await this.ensureOpenHandoff(tx, now, conversationId, dispatcherAccountId);
    const message = await this.conversations.appendMessage(tx, conversationId, now, {
      author: 'dispatcher',
      kind: 'text',
      text,
      authorAccountId: dispatcherAccountId,
    });
    await tx.aiHandoff.update({
      where: { id: open.id },
      data: {
        state: 'answered',
        firstReplyAt: open.firstReplyAt ?? BigInt(now),
        dispatcherLastReadSeq: message.seq,
        version: { increment: 1 },
      },
    });
    return { ...(await this.reread(tx, open.id, conversationId)), message };
  }

  /**
   * Ends the handover: the assistant takes the dialogue back, and the same conversation
   * stays the person's one chat. No closing bubble is written -- the turn is a divider
   * on the client and engineer screens, not a message in the stream.
   *
   * Message history is untouched and no domain write this dispatcher already applied is
   * reverted (context/36 section 9.3).
   */
  async finish(
    tx: Tx,
    now: number,
    conversationId: string,
    dispatcherAccountId: string,
  ): Promise<{ handoff: AiHandoff; conversation: AiConversation }> {
    const open = await this.lockOpenHandoff(tx, conversationId);
    const last = await tx.aiMessage.aggregate({
      where: { conversationId },
      _max: { seq: true },
    });
    const endSeq = last._max.seq ?? open.startSeq;
    await tx.aiHandoff.update({
      where: { id: open.id },
      data: {
        state: 'closed',
        closedAt: BigInt(now),
        closedByAccountId: dispatcherAccountId,
        endSeq,
        dispatcherLastReadSeq: endSeq,
        version: { increment: 1 },
      },
    });
    await tx.aiConversation.update({
      where: { id: conversationId },
      data: { mode: 'ai', updatedAt: BigInt(now), version: { increment: 1 } },
    });
    return this.reread(tx, open.id, conversationId);
  }

  /**
   * Records that the counterpart has written and no dispatcher has answered since.
   *
   * Called from the message endpoint the client and engineer apps use, which is the one
   * place that knows a message arrived from the other side. Returns `null` for a dialogue
   * that is not in a handover -- an ordinary assistant conversation is not the dispatcher's
   * business and must not appear in their list.
   */
  async markAwaitingDispatcher(tx: Tx, conversationId: string): Promise<AiHandoff | null> {
    const open = await tx.aiHandoff.findFirst({
      where: { conversationId, state: { not: 'closed' } },
    });
    if (!open) {
      return null;
    }
    if (open.state === 'waiting') {
      return open;
    }
    await tx.aiHandoff.updateMany({
      where: { id: open.id, state: 'answered' },
      data: { state: 'waiting', version: { increment: 1 } },
    });
    return tx.aiHandoff.findUniqueOrThrow({ where: { id: open.id } });
  }

  /**
   * Moves the dispatcher's read cursor forward, never back: opening an old chat in a
   * second tab must not resurrect a badge the first tab already cleared. A chat with no
   * live handover is a no-op rather than an error -- there is nothing left to mark read.
   */
  async markRead(tx: Tx, conversationId: string, seq: number): Promise<AiHandoff | null> {
    const open = await tx.aiHandoff.findFirst({
      where: { conversationId, state: { not: 'closed' } },
    });
    if (!open) {
      return null;
    }
    await tx.aiHandoff.updateMany({
      where: { id: open.id, dispatcherLastReadSeq: { lt: seq } },
      data: { dispatcherLastReadSeq: seq },
    });
    return tx.aiHandoff.findUniqueOrThrow({ where: { id: open.id } });
  }

  /**
   * The handover a dispatcher message needs. An open one is reused. A finished dialogue,
   * or one that was never handed over, starts a new episode at the current end of the
   * history: sending is what joins the chat, and it joins the same conversation.
   */
  private async ensureOpenHandoff(
    tx: Tx,
    now: number,
    conversationId: string,
    dispatcherAccountId: string,
  ): Promise<AiHandoff> {
    await tx.$queryRaw`SELECT id FROM ai_conversations WHERE id = ${conversationId} FOR UPDATE`;
    const conversation = await tx.aiConversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      throw SysError.notFound('Conversation', { conversationId });
    }
    const open = await tx.aiHandoff.findFirst({
      where: { conversationId, state: { not: 'closed' } },
    });
    if (open && conversation.mode === 'dispatcher') return open;

    const previous = await tx.aiHandoff.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
    const last = await tx.aiMessage.aggregate({
      where: { conversationId },
      _max: { seq: true },
    });
    const startSeq = last._max.seq ?? 0;
    const created = await tx.aiHandoff.create({
      data: {
        conversationId,
        requestedByAccountId: dispatcherAccountId,
        actorRole: previous?.actorRole ?? conversation.role,
        initiatedBy: 'dispatcher',
        requestIds: previous?.requestIds ?? [],
        engineerIds: previous?.engineerIds ?? [],
        state: 'answered',
        dispatcherLastReadSeq: startSeq,
        startSeq,
        createdAt: BigInt(now),
      },
    });
    await tx.aiConversation.update({
      where: { id: conversationId },
      data: { mode: 'dispatcher', updatedAt: BigInt(now), version: { increment: 1 } },
    });
    return created;
  }

  /**
   * Locks the conversation row, then returns its open handover. Throws
   * `AI_HANDOFF_NOT_ACTIVE` when the dialogue is not currently with a dispatcher.
   * `finish` uses this so a second close is refused. A reply does not: sending is
   * how a dispatcher joins, including after the assistant has taken the chat back.
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

  /**
   * Who the dashboard button points at, as an account this service can actually write a
   * dialogue for.
   *
   * Both misses are refused as `CHAT_TARGET_UNREACHABLE` rather than `NOT_FOUND`: the
   * request and the engineer do exist, and telling the dispatcher "не найдено" about
   * someone they are looking at would read as a bug rather than as "this person has no
   * app, phone them". The role check is the same rule as everywhere else -- roles are
   * granted, never inferred from a link (context/36 section 7.3) -- and it also stops a
   * conversation being created in a lane its owner could never open.
   */
  private async resolveTarget(tx: Tx, target: DispatchChatTarget): Promise<ResolvedTarget> {
    if (target.kind === 'engineer') {
      const engineer = await tx.engineer.findUnique({ where: { id: target.engineerId } });
      if (!engineer) {
        throw SysError.notFound('Engineer', { engineerId: target.engineerId });
      }
      if (!engineer.accountId) {
        // Reaches the dispatcher's screen verbatim, so it is written for them: the UI
        // shows `message` as-is and the whole product speaks Russian.
        throw new SysError(
          'CHAT_TARGET_UNREACHABLE',
          'У инженера нет входа в приложение — привяжите почту, чтобы открыть чат',
          { details: { engineerId: engineer.id } },
        );
      }
      await this.assertRole(tx, engineer.accountId, 'engineer', { engineerId: engineer.id });
      return {
        accountId: engineer.accountId,
        role: 'engineer',
        roleProfile: 'engineer',
        title: `Инженер · ${reserveDisplayName(engineer.displayName)}`,
        contextRef: { engineerId: engineer.id },
        requestIds: [],
        engineerIds: [engineer.id],
      };
    }

    const request = await tx.request.findUnique({ where: { id: target.requestId } });
    if (!request) {
      throw SysError.notFound('Request', { requestId: target.requestId });
    }
    if (!request.clientAccountId) {
      throw new SysError(
        'CHAT_TARGET_UNREACHABLE',
        'У этой заявки нет личного кабинета клиента — писать некуда',
        { details: { requestId: request.id } },
      );
    }
    await this.assertRole(tx, request.clientAccountId, 'client', { requestId: request.id });
    return {
      accountId: request.clientAccountId,
      role: 'client',
      roleProfile: 'client',
      title: `Клиент · ${request.contactName ?? request.addressText}`,
      contextRef: { requestId: request.id },
      requestIds: [request.id],
      engineerIds: [],
    };
  }

  private async assertRole(
    tx: Tx,
    accountId: string,
    role: Role,
    details: Record<string, unknown>,
  ): Promise<void> {
    const granted = await tx.accountRole.findUnique({
      where: { accountId_role: { accountId, role } },
    });
    if (!granted) {
      throw new SysError(
        'CHAT_TARGET_UNREACHABLE',
        'У этого аккаунта нет нужной роли, диалог в этой ветке невозможен',
        { details: { ...details, accountId } },
      );
    }
  }

  /** The handover and conversation as they stand after a write in this transaction, so a
   *  caller publishes and renders the committed state rather than the row it started from. */
  private async reread(
    tx: Tx,
    handoffId: string,
    conversationId: string,
  ): Promise<{ handoff: AiHandoff; conversation: AiConversation }> {
    const [handoff, conversation] = await Promise.all([
      tx.aiHandoff.findUniqueOrThrow({ where: { id: handoffId } }),
      tx.aiConversation.findUniqueOrThrow({ where: { id: conversationId } }),
    ]);
    return { handoff, conversation };
  }

  /**
   * Attaches each episode's messages and unread count in two queries rather than two per
   * row.
   *
   * Every row shows the dialogue's whole history. Finishing a handover hands the same
   * chat back to the assistant; later messages stay on this row rather than starting
   * another one. Unread counts only the other person's messages that arrived after the
   * episode started and after the dispatcher last looked -- earlier history is context.
   */
  private async hydrate(
    handoffs: Array<AiHandoff & { conversation: AiConversation }>,
  ): Promise<DispatchChatRow[]> {
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
    return handoffs.map(({ conversation, ...handoff }) => {
      const all = byConversation.get(handoff.conversationId) ?? [];
      const readFloor = Math.max(handoff.dispatcherLastReadSeq, handoff.startSeq);
      return {
        handoff,
        conversation,
        messages: all,
        // A finished chat never badges: the assistant holds it, and only a live handover
        // is the dispatcher's to answer. History from before this episode is not unread.
        unreadCount:
          handoff.state === 'closed'
            ? 0
            : all.filter((m) => m.author === 'user' && m.seq > readFloor).length,
      };
    });
  }
}
