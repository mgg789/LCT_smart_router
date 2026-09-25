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
  readonly role: string;
  readonly mode: string;
  readonly assistMode: string;
  readonly roleProfile: string;
  /** Which request/engineer/alert the dialogue was opened about, if any. */
  readonly contextRef: unknown;
  readonly title: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastMessageAt: number;
  readonly closedAt: number | null;
  readonly version: number;
}

export function toConversationView(conversation: AiConversation): AiConversationView {
  return {
    id: conversation.id,
    role: conversation.role,
    mode: conversation.mode,
    assistMode: conversation.assistMode,
    roleProfile: conversation.roleProfile,
    contextRef: conversation.contextRef,
    title: conversation.title,
    createdAt: bigIntToSeconds(conversation.createdAt),
    updatedAt: bigIntToSeconds(conversation.updatedAt),
    lastMessageAt: bigIntToSeconds(conversation.lastMessageAt),
    closedAt: bigIntToSecondsOrNull(conversation.closedAt),
    version: conversation.version,
  };
}

export interface AiMessageView {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly author: string;
  readonly kind: string;
  readonly text: string;
  readonly actions: readonly unknown[];
  readonly runId: string | null;
  readonly operationId: string | null;
  /** Set only for `dispatcher` authorship, so a reply is attributable to the human who
   *  actually sent it (schema.prisma's own comment on the column). */
  readonly authorAccountId: string | null;
  readonly createdAt: number;
}

export function toMessageView(message: AiMessage): AiMessageView {
  return {
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    author: message.author,
    kind: message.kind,
    text: message.text,
    actions: Array.isArray(message.actions) ? message.actions : [],
    runId: message.runId,
    operationId: message.operationId,
    authorAccountId: message.authorAccountId,
    createdAt: bigIntToSeconds(message.createdAt),
  };
}
