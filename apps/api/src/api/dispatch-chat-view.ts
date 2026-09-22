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
 * What the «Чаты» page is shown about one handoff: who started it and in what role, the
 * related request/engineer ids, when it began, and whether a human has answered yet --
 * `state` and `firstReplyAt` are the source of truth for waiting-vs-answered, never
 * `conversation.mode` (every listed chat is already in `dispatcher` mode, so that field
 * cannot distinguish the two on its own).
 */
export interface AiHandoffView {
  readonly id: string;
  readonly conversationId: string;
  readonly requestedByAccountId: string;
  readonly actorRole: string;
  readonly requestIds: readonly string[];
  readonly engineerIds: readonly string[];
  readonly state: string;
  readonly createdAt: number;
  readonly firstReplyAt: number | null;
}

export function toHandoffView(handoff: AiHandoff): AiHandoffView {
  return {
    id: handoff.id,
    conversationId: handoff.conversationId,
    requestedByAccountId: handoff.requestedByAccountId,
    actorRole: handoff.actorRole,
    requestIds: handoff.requestIds,
    engineerIds: handoff.engineerIds,
    state: handoff.state,
    createdAt: bigIntToSeconds(handoff.createdAt),
    firstReplyAt: bigIntToSecondsOrNull(handoff.firstReplyAt),
  };
}

export interface DispatchChatView {
  readonly handoff: AiHandoffView;
  readonly conversation: AiConversationView;
  readonly messages: readonly AiMessageView[];
}

export function toDispatchChatView(row: DispatchChatRow): DispatchChatView {
  return {
    handoff: toHandoffView(row.handoff),
    conversation: toConversationView(row.conversation),
    messages: row.messages.map(toMessageView),
  };
}
