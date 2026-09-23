import type { DispatchChatView } from '@/entities/chat';
import type { Contact } from './contacts';

/**
 * The chat list is keyed by handover episode, the contact list by person, so the
 * screen has to bring the two together.
 *
 * A dialogue can be handed over more than once in a day, and each episode is its
 * own row. What the dispatcher wants to see for a person is the one that still
 * needs them — and only when there is none, the last one that ended.
 */
export function chatForContact(
  chats: DispatchChatView[],
  contact: Contact,
): DispatchChatView | null {
  const ids = new Set(contact.matchIds);
  const mine = chats.filter((chat) =>
    contact.kind === 'engineers'
      ? chat.handoff.engineerIds.some((id) => ids.has(id))
      : chat.handoff.requestIds.some((id) => ids.has(id)),
  );
  if (mine.length === 0) return null;

  const live = mine.filter((chat) => chat.handoff.state !== 'closed');
  if (live.length > 0) {
    // Only one episode of a dialogue can be live, but a person may hold several
    // dialogues; the one that spoke last is the one being read.
    return live.reduce((newest, chat) =>
      chat.conversation.lastMessageAt > newest.conversation.lastMessageAt ? chat : newest,
    );
  }
  return mine.reduce((newest, chat) =>
    (chat.handoff.closedAt ?? 0) > (newest.handoff.closedAt ?? 0) ? chat : newest,
  );
}

/**
 * What the row under a name says once a chat exists.
 *
 * Read from `handoff.state`, never from `conversation.mode`: a live chat is
 * always in `dispatcher` mode and a finished one always back in `ai`, so mode
 * cannot tell waiting from answered (docs/frontend-api.md §9.8). Before the
 * first reply the honest word is «ждёт ответа» — never a claim that an operator
 * has already joined.
 */
export function chatStatus(chat: DispatchChatView | null): string | null {
  if (!chat) return null;
  switch (chat.handoff.state) {
    case 'waiting':
      return 'Ждёт ответа';
    case 'answered':
      return 'Вы ответили';
    case 'closed':
      return 'Передача завершена';
    default:
      return chat.handoff.state;
  }
}

/**
 * The messages of one episode, in the order they were written.
 *
 * A finished episode is already cut to its `endSeq` by the server, so the
 * conversation reads as it stood when it closed rather than growing afterwards.
 */
export function threadMessages(chat: DispatchChatView | null) {
  return chat ? [...chat.messages].sort((left, right) => left.seq - right.seq) : [];
}

/** The newest `seq` in a thread: what the read cursor is moved to. */
export function lastSeq(chat: DispatchChatView | null): number | null {
  const messages = threadMessages(chat);
  return messages.length > 0 ? (messages.at(-1)?.seq ?? null) : null;
}
