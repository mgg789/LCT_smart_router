import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getDispatchChats } from '../api/chats';
import type { DispatchChatView } from './types';

export const dispatchChatsQueryKey = ['dispatch', 'chats'] as const;

/**
 * Backstop poll for the chat list.
 *
 * The live delivery is `GET /dispatch/chats/events`, which has no replay — so
 * this slow re-read is what makes a dropped stream self-heal, and what recomputes
 * `unreadCount` for every dialogue rather than only the ones being watched.
 */
export const CHATS_POLL_MS = 20_000;

export function useDispatchChats() {
  return useQuery<{ chats: DispatchChatView[] }, ApiError>({
    queryKey: dispatchChatsQueryKey,
    queryFn: () => getDispatchChats(),
    refetchInterval: CHATS_POLL_MS,
  });
}

/** Chats still waiting on the dispatcher: what a badge would count. */
export function countWaiting(chats: DispatchChatView[] | undefined): number {
  return (chats ?? []).filter((chat) => chat.handoff.state === 'waiting').length;
}
