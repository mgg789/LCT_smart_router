import { Headset, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AiMessageAuthor, AiRoleProfile, DispatchChatView } from '../api/ai';
import { formatClock } from '../lib/time';

interface Props {
  readonly token: string | null;
  readonly chats: DispatchChatView[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly writesDisabled: boolean;
  readonly onSendMessage: (chatId: string, text: string) => Promise<void>;
  readonly onFinish: (chatId: string) => Promise<void>;
  readonly onRefresh: () => void;
}

/** Which side of a `user` message actually spoke, since `AiMessageAuthor` only knows
 * `user`/`assistant`/`dispatcher`/`system` and not who the `user` role belongs to. */
function userLabel(roleProfile: AiRoleProfile): string {
  return roleProfile === 'engineer' ? 'Инженер' : 'Клиент';
}

function authorLabel(author: AiMessageAuthor, roleProfile: AiRoleProfile): string {
  switch (author) {
    case 'user':
      return userLabel(roleProfile);
    case 'assistant':
      return 'AI';
    case 'dispatcher':
      return 'Диспетчер';
    case 'system':
      return 'Система';
  }
}

/** Conversations a human dispatcher has been handed. Every listed chat is already in
 * `dispatcher` mode, so waiting vs answered comes from the handoff's own `state`
 * (`waiting` until the first dispatcher reply, `answered` after) rather than
 * `conversation.mode` -- that field cannot distinguish the two once a chat is on this
 * page at all. */
export function ChatsPage({
  token,
  chats,
  loading,
  error,
  writesDisabled,
  onSendMessage,
  onFinish,
  onRefresh,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = chats ?? [];
  const selected = list.find((chat) => chat.conversation.id === selectedId) ?? list[0] ?? null;

  useEffect(() => {
    if (selectedId === null && list.length > 0) {
      const first = list[0];
      if (first) setSelectedId(first.conversation.id);
    }
  }, [selectedId, list]);

  if (token === null) {
    return (
      <main className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        <section className="mx-auto max-w-5xl rounded-3xl bg-white p-6 text-center text-sm text-muted shadow-sm">
          Чаты доступны только в живом контуре — подключитесь к рабочему серверу.
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-0 flex-1 overflow-auto px-4 pb-4">
      <section className="mx-auto grid max-w-5xl grid-cols-1 gap-4 rounded-3xl bg-white p-6 shadow-sm md:grid-cols-[18rem_1fr]">
        <div className="md:col-span-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Чаты</h1>
            <p className="mt-2 text-sm text-muted">
              Диалоги, переданные диспетчеру. Ответ здесь ведёт диалог до «Завершить передачу».
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm"
          >
            <RefreshCw className="h-4 w-4" />
            Обновить
          </button>
        </div>
        {error ? (
          <p
            role="alert"
            className="md:col-span-2 rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
        {loading && list.length === 0 ? (
          <p className="md:col-span-2 text-sm text-muted">Загружаем чаты…</p>
        ) : list.length === 0 ? (
          <p className="md:col-span-2 rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted">
            Сейчас нет диалогов, переданных диспетчеру.
          </p>
        ) : (
          <>
            <ul className="space-y-1">
              {list.map((chat) => {
                const active = chat.conversation.id === selected?.conversation.id;
                const answered = chat.handoff.state !== 'waiting';
                const last = chat.messages[chat.messages.length - 1];
                return (
                  <li key={chat.conversation.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(chat.conversation.id)}
                      className={`w-full rounded-xl px-3 py-2.5 text-left text-sm ${
                        active ? 'bg-canvas' : 'hover:bg-canvas/60'
                      }`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {chat.conversation.title ?? userLabel(chat.conversation.roleProfile)}
                        </span>
                        {chat.unreadCount > 0 ? (
                          <span className="rounded-full bg-bee px-1.5 text-xs font-semibold text-ink">
                            {chat.unreadCount}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-muted">
                        {answered ? 'Ответ отправлен' : 'Ожидает ответа'}
                      </span>
                      {last ? (
                        <span className="mt-0.5 block truncate text-[12px] text-muted">
                          {last.text}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {selected ? (
              <ChatThread
                key={selected.conversation.id}
                chat={selected}
                writesDisabled={writesDisabled}
                onSendMessage={(text) => onSendMessage(selected.conversation.id, text)}
                onFinish={() => onFinish(selected.conversation.id)}
              />
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

function ChatThread({
  chat,
  writesDisabled,
  onSendMessage,
  onFinish,
}: {
  readonly chat: DispatchChatView;
  readonly writesDisabled: boolean;
  readonly onSendMessage: (text: string) => Promise<void>;
  readonly onFinish: () => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const answered = chat.handoff.state !== 'waiting';

  async function submit() {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    setActionError(null);
    try {
      await onSendMessage(text);
      setDraft('');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Не удалось отправить сообщение');
    } finally {
      setSending(false);
    }
  }

  async function finish() {
    setFinishing(true);
    setActionError(null);
    try {
      await onFinish();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Не удалось завершить передачу');
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="flex min-h-[24rem] flex-col overflow-hidden rounded-2xl border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-canvas px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <Headset className="h-4 w-4 text-muted" />
          {answered ? 'Диалог ведёт диспетчер' : 'Ожидаем первого ответа диспетчера'}
        </div>
        <button
          type="button"
          disabled={writesDisabled || finishing}
          onClick={() => void finish()}
          className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {finishing ? 'Завершаем…' : 'Завершить передачу'}
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {chat.messages.length === 0 ? (
          <p className="text-sm text-muted">Сообщений пока нет.</p>
        ) : (
          chat.messages.map((message) => (
            <div key={message.id} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted">
                {authorLabel(message.author, chat.conversation.roleProfile)} ·{' '}
                {formatClock(message.createdAt)}
              </span>
              <p className="rounded-2xl border border-line bg-white px-3 py-2 text-sm">
                {message.text}
              </p>
            </div>
          ))
        )}
      </div>
      <div className="shrink-0 space-y-2 border-t border-line p-3">
        {actionError ? (
          <p role="alert" className="text-xs text-muted">
            {actionError}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={writesDisabled || sending}
            rows={2}
            placeholder="Ответить в диалог…"
            className="min-h-[2.5rem] flex-1 resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-sm disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={writesDisabled || sending || draft.trim().length === 0}
            className="shrink-0 rounded-full bg-bee px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {sending ? 'Отправляем…' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}
