import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ChatStreamEvent, DispatchChatView } from '@/entities/chat';
import { dispatchChatsQueryKey, streamChatEvents } from '@/entities/chat';

/**
 * Folds one streamed message into the cached chat list.
 *
 * Deduplication is per conversation, by the `seq` the server assigned inside that
 * dialogue. A single counter across the list would be wrong: `seq` grows within
 * one dialogue, not across them, so a quiet conversation's message would look
 * older than a busy neighbour's and be dropped (docs/frontend-api.md §9.4).
 */
export function applyChatEvent(
  cached: { chats: DispatchChatView[] } | undefined,
  event: ChatStreamEvent,
): { chats: DispatchChatView[] } | undefined {
  if (!cached || event.type !== 'message') return cached;
  return {
    chats: cached.chats.map((chat) => {
      if (chat.conversation.id !== event.conversationId) return chat;
      if (chat.messages.some((message) => message.seq === event.message.seq)) return chat;
      return { ...chat, messages: [...chat.messages, event.message] };
    }),
  };
}

/**
 * Follows `GET /dispatch/chats/events` for as long as the screen is open.
 *
 * The stream carries no replay, so it is a live overlay and not the source of
 * truth: each message is folded into the cached list for an immediate thread,
 * and the list is then re-read so the server recomputes what this client cannot
 * — every row's `unreadCount`, including the dialogues nobody is looking at.
 * A dropped stream therefore costs nothing but latency; the backstop poll and
 * this refetch heal it.
 */
export function useChatStream(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let stopped = false;

    void (async () => {
      try {
        for await (const event of streamChatEvents(abort.signal)) {
          if (stopped) return;
          queryClient.setQueryData<{ chats: DispatchChatView[] }>(dispatchChatsQueryKey, (cached) =>
            applyChatEvent(cached, event),
          );
          void queryClient.invalidateQueries({ queryKey: dispatchChatsQueryKey });
        }
      } catch {
        // A broken stream is not a broken screen: the list keeps polling, and
        // the next read brings back whatever the gap held.
      }
    })();

    return () => {
      stopped = true;
      abort.abort();
    };
  }, [enabled, queryClient]);
}
