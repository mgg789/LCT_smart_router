import type { AiConversation, AiMessage } from '@/entities/conversation';
import { authorizedRequest, useSessionStore } from '@/entities/session';
import { readEventStream } from '@/shared/api';
import { newOperationId } from '@/shared/lib';
import type { ChatStreamEvent, ChatTarget, DispatchChatView } from '../model/types';

/**
 * `GET /dispatch/chats` — live handovers first, then the finished ones.
 *
 * A finished chat stays in the list rather than vanishing when it closes; only
 * how many of them one page carries is capped (docs/frontend-api.md §9.8).
 */
export function getDispatchChats(closedLimit?: number): Promise<{ chats: DispatchChatView[] }> {
  const query = closedLimit === undefined ? '' : `?closedLimit=${closedLimit}`;
  return authorizedRequest(`/dispatch/chats${query}`);
}

/**
 * `POST /dispatch/chats` — writes to a request's customer or to an engineer.
 *
 * The browser names the object, never the account: the server finds the person
 * behind a request or an engineer itself. Pressing again while the chat is open
 * is not an error and does not open a second one. `409 CHAT_TARGET_UNREACHABLE`
 * means the object exists but has nobody to write to — an imported customer, or
 * an engineer with no login — which is deliberately not a 404.
 */
export function openDispatchChat(
  target: ChatTarget,
  text?: string,
): Promise<{ chat: DispatchChatView }> {
  return authorizedRequest('/dispatch/chats', {
    method: 'POST',
    body: { operationId: newOperationId(), target, ...(text ? { text } : {}) },
  });
}

/**
 * `POST /dispatch/chats/:id/messages` — the dispatcher's reply, by conversation id.
 *
 * The first reply moves the handover from `waiting` to `answered`; every reply
 * also moves the read cursor, so answering is itself the acknowledgement and
 * needs no separate call.
 */
export function sendChatMessage(
  conversationId: string,
  text: string,
): Promise<{ message: AiMessage; chat: DispatchChatView }> {
  return authorizedRequest(`/dispatch/chats/${conversationId}/messages`, {
    method: 'POST',
    body: { operationId: newOperationId(), text },
  });
}

/**
 * `POST /dispatch/chats/:id/finish` — hands the dialogue back to the assistant.
 *
 * History and anything already applied are kept, and the row stays in the list
 * as closed rather than disappearing.
 */
export function finishChat(
  conversationId: string,
): Promise<{ conversation: AiConversation; chat: DispatchChatView }> {
  return authorizedRequest(`/dispatch/chats/${conversationId}/finish`, {
    method: 'POST',
    body: { operationId: newOperationId() },
  });
}

/**
 * `POST /dispatch/chats/:id/read` — moves the read cursor forward, never back.
 *
 * A stale tab replaying an old `seq` therefore cannot bring back a badge that was
 * already cleared. `chat: null` means the dialogue has no open handover right
 * now — nothing to clear, and not an error.
 */
export function markChatRead(
  conversationId: string,
  seq: number,
): Promise<{ chat: DispatchChatView | null }> {
  return authorizedRequest(`/dispatch/chats/${conversationId}/read`, {
    method: 'POST',
    body: { operationId: newOperationId(), seq },
  });
}

/**
 * `GET /dispatch/chats/events` — every dialogue the dispatcher holds right now.
 *
 * This stream has no replay: catching up is an ordinary `GET /dispatch/chats`,
 * which already carries each row with its `unreadCount` computed. A reader must
 * keep the last seen `seq` **per conversation** — `seq` grows inside one dialogue,
 * so a single counter across the list would silently swallow messages from a
 * dialogue that writes less often than its neighbour (§9.4).
 */
export function streamChatEvents(signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
  return readEventStream<ChatStreamEvent>('/dispatch/chats/events', {
    token: useSessionStore.getState().session?.token ?? null,
    signal,
  });
}
