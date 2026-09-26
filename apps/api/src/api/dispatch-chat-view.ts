import type { DispatchChatRow } from '../ai/runtime';
import { bigIntToSeconds, bigIntToSecondsOrNull } from '../common/time';
import type { AiHandoff } from '../generated/prisma/client';
import {
  type AiConversationView,
  type AiMessageView,
  toConversationView,
  toMessageView,
} from './ai-view';

/**
 * What the «Чаты» page is shown about one chat episode: which side opened it, who it is
 * with, the related request/engineer ids, where in the dialogue it begins and ends, and
 * whether it is waiting on the dispatcher right now.
 *
 * `state` is the source of truth for waiting-vs-answered, never `conversation.mode`: a
 * live chat is always in `dispatcher` mode and a finished one is always back in `ai`, so
 * that field cannot tell "нужен ответ" from "ответ отправлен" at all. `state` can move
 * both ways -- it returns to `waiting` whenever the other side writes and no dispatcher
 * reply has followed -- while `firstReplyAt` is stamped once and never revised.
 */
export interface AiHandoffView {
  readonly id: string;
  readonly conversationId: string;
  readonly requestedByAccountId: string;
  /** Always the counterpart's role (`client` or `engineer`), whichever side opened the
   *  chat, so the list can group by it in both directions. */
  readonly actorRole: string;
  /** `user` when the assistant escalated, `dispatcher` when the chat was opened from the
   *  dashboard. */
  readonly initiatedBy: string;
  readonly requestIds: readonly string[];
  readonly engineerIds: readonly string[];
  readonly state: string;
  /** Message `seq` the dialogue stood at when this chat opened: everything at or below it
   *  is the history that came before, which the dispatcher reads as context. */
  readonly startSeq: number;
  /** Message `seq` this chat ended at, or `null` while it is still running. */
  readonly endSeq: number | null;
  readonly createdAt: number;
  readonly firstReplyAt: number | null;
  readonly closedAt: number | null;
}

export function toHandoffView(handoff: AiHandoff): AiHandoffView {
  return {
    id: handoff.id,
    conversationId: handoff.conversationId,
    requestedByAccountId: handoff.requestedByAccountId,
    actorRole: handoff.actorRole,
    requestIds: handoff.requestIds,
    engineerIds: handoff.engineerIds,
    initiatedBy: handoff.initiatedBy,
    state: handoff.state,
    startSeq: handoff.startSeq,
    endSeq: handoff.endSeq,
    createdAt: bigIntToSeconds(handoff.createdAt),
    firstReplyAt: bigIntToSecondsOrNull(handoff.firstReplyAt),
    closedAt: bigIntToSecondsOrNull(handoff.closedAt),
  };
}

/**
 * One row of the dispatcher's chat list.
 *
 * Identified by `handoff.id`, not by the conversation: one person's dialogue can be handed
 * over more than once over a day, and each episode is its own row with its own outcome.
 * Writes are still addressed by `conversation.id` -- only one episode of a dialogue can be
 * live at a time, so there is never an ambiguous target.
 */
export interface DispatchChatView {
  readonly handoff: AiHandoffView;
  readonly conversation: AiConversationView;
  readonly messages: readonly AiMessageView[];
  /** Messages from the other side that arrived after the dispatcher's read cursor. Always
   *  0 for a finished chat: there is nothing left to do about it. */
  readonly unreadCount: number;
}

export function toDispatchChatView(row: DispatchChatRow): DispatchChatView {
  return {
    handoff: toHandoffView(row.handoff),
    conversation: toConversationView(row.conversation),
    messages: row.messages.map(toMessageView),
    unreadCount: row.unreadCount,
  };
}
