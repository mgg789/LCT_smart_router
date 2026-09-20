import { bigIntToSeconds, bigIntToSecondsOrNull } from '../common/time';
import type { AiConversation, AiMessage } from '../generated/prisma/client';

/**
 * What a caller is shown about a conversation or a message.
 *
 * Every `bigint` from the stored row is converted here and nowhere else on this path
 * (`src/common/time/bigint-boundary.ts`), matching `request-view.ts`'s own convention.
 */
export interface AiConversationView {
  readonly id: string;
  readonly mode: string;
  readonly assistMode: string;
  readonly roleProfile: string;
  readonly title: string | null;
  readonly createdAt: number;
  readonly lastMessageAt: number;
  readonly closedAt: number | null;
  readonly version: number;
}

export function toConversationView(conversation: AiConversation): AiConversationView {
  return {
    id: conversation.id,
    mode: conversation.mode,
    assistMode: conversation.assistMode,
    roleProfile: conversation.roleProfile,
    title: conversation.title,
    createdAt: bigIntToSeconds(conversation.createdAt),
    lastMessageAt: bigIntToSeconds(conversation.lastMessageAt),
    closedAt: bigIntToSecondsOrNull(conversation.closedAt),
    version: conversation.version,
  };
}

export interface AiMessageView {
  readonly id: string;
  readonly seq: number;
  readonly author: string;
  readonly kind: string;
  readonly text: string;
  readonly actions: readonly unknown[];
  readonly runId: string | null;
  readonly operationId: string | null;
  readonly createdAt: number;
}

export function toMessageView(message: AiMessage): AiMessageView {
  return {
    id: message.id,
    seq: message.seq,
    author: message.author,
    kind: message.kind,
    text: message.text,
    actions: Array.isArray(message.actions) ? message.actions : [],
    runId: message.runId,
    operationId: message.operationId,
    createdAt: bigIntToSeconds(message.createdAt),
  };
}
