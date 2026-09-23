import type { AiConversation, AiMessage } from '@/entities/conversation';

/**
 * The dispatcher's side of a handover (docs/frontend-api.md §9.8).
 *
 * `state` is the only field that says whether this chat needs an answer.
 * `conversation.mode` cannot: a live chat is always in `dispatcher` mode and a
 * finished one is always back in `ai`, so it tells waiting from answered not at
 * all. `state` moves both ways — it returns to `waiting` whenever the other side
 * writes without a reply following — while `firstReplyAt` is stamped once.
 */
export interface AiHandoff {
  id: string;
  conversationId: string;
  requestedByAccountId: string;
  /** Always the counterpart's role — `client` or `engineer`, never `dispatcher`. */
  actorRole: string;
  /** `user` when the assistant escalated, `dispatcher` when the chat was opened here. */
  initiatedBy: string;
  requestIds: string[];
  engineerIds: string[];
  state: string;
  /** Where this episode begins in the dialogue; everything below it is prior context. */
  startSeq: number;
  /** Where it ended, or null while it runs. */
  endSeq: number | null;
  createdAt: number;
  firstReplyAt: number | null;
  closedAt: number | null;
}

export interface DispatchChatView {
  handoff: AiHandoff;
  conversation: AiConversation;
  messages: AiMessage[];
  /** Counted by the server past its own read cursor; always 0 once closed. */
  unreadCount: number;
}

/** Who a new chat is addressed to; the server resolves the account itself. */
export type ChatTarget =
  | { kind: 'request'; requestId: string }
  | { kind: 'engineer'; engineerId: string };

/**
 * The human↔human stream (§9.4) — a different union from `AiRunEvent`.
 *
 * There is no `message_delta` and no terminal event: a conversation between two
 * people has neither an ephemeral middle nor an end the stream must announce.
 * `state` carries the whole position rather than a transition, so receiving it
 * twice — or missing one between reconnects — cannot distort the picture.
 */
export type ChatStreamEvent =
  | { type: 'message'; at: number; conversationId: string; message: AiMessage }
  | {
      type: 'state';
      at: number;
      conversationId: string;
      mode: string;
      handoff: AiHandoff | null;
    };

/** A chat is waiting on the dispatcher when the counterpart spoke last. */
export function isWaiting(chat: DispatchChatView): boolean {
  return chat.handoff.state === 'waiting';
}

export function isClosed(chat: DispatchChatView): boolean {
  return chat.handoff.state === 'closed';
}
