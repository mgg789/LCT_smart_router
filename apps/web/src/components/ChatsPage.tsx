import { CheckCircle2, Headset, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AiMessage, AiMessageAuthor, AiRoleProfile, DispatchChatView } from '../api/ai';
import { formatClock } from '../lib/time';
import { ChatBottomSpacer } from './ai/ChatBottomSpacer';

interface Props {
  readonly token: string | null;
  readonly chats: DispatchChatView[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly writesDisabled: boolean;
  readonly onSendMessage: (conversationId: string, text: string) => Promise<void>;
  readonly onFinish: (conversationId: string) => Promise<void>;
  readonly onRefresh: () => void;
  readonly onMarkRead: (conversationId: string, seq: number) => void;
  /** Lets the host page point this list at one specific episode -- e.g. right after a
   * «Написать» button elsewhere opens a chat. Omitted (both this and `onSelectHandoff`),
   * the page manages its own selection and defaults to the first row. */
  readonly selectedHandoffId?: string | null;
  readonly onSelectHandoff?: (handoffId: string) => void;
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

/** Who opened this episode: the assistant escalating on the person's behalf (`initiatedBy
 * === 'user'`), or a dispatcher reaching out first from elsewhere in the dashboard. */
function originLabel(chat: DispatchChatView): string {
  if (chat.handoff.initiatedBy === 'dispatcher') return 'Вы написали первым';
  return chat.conversation.roleProfile === 'engineer'
    ? 'Инженер попросил диспетчера'
    : 'Клиент попросил диспетчера';
}

/** The seq to mark a chat read up to: the newest message it has, or the handover's own
 * starting cursor for a chat that somehow has none yet. */
function lastSeqOf(chat: DispatchChatView): number {
  const last = chat.messages[chat.messages.length - 1];
  return last ? last.seq : chat.handoff.startSeq;
}

/** Conversations a human dispatcher has been handed. Every listed chat is already in
 * `dispatcher` mode, so waiting vs answered comes from the handoff's own `state`
 * (`waiting` until the first dispatcher reply, `answered` after, `closed` once finished)
 * rather than `conversation.mode` -- that field cannot distinguish these once a chat is on
 * this page at all. Rows are keyed by `handoff.id`, not `conversation.id`: the same person
 * can be handed over several times in a day, and each episode is its own row. */
export function ChatsPage({
  token,
  chats,
  loading,
  error,
  writesDisabled,
  onSendMessage,
  onFinish,
  onRefresh,
  onMarkRead,
  selectedHandoffId,
  onSelectHandoff,
}: Props) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);
  // Controlled only when the host page opts in by passing `selectedHandoffId` -- everyday
  // navigation inside this page (clicking a row) still just needs its own state.
  const controlled = selectedHandoffId !== undefined;
  const selectedId = controlled ? selectedHandoffId : internalSelectedId;
  const list = chats ?? [];
  const live = list.filter((chat) => chat.handoff.state !== 'closed');
  const finished = list.filter((chat) => chat.handoff.state === 'closed');
  const ordered = [...live, ...finished];
  const selected = ordered.find((chat) => chat.handoff.id === selectedId) ?? ordered[0] ?? null;

  function selectHandoff(handoffId: string) {
    if (controlled) onSelectHandoff?.(handoffId);
    else setInternalSelectedId(handoffId);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the pick would change
  useEffect(() => {
    if (selectedId === null && ordered.length > 0) {
      const first = ordered[0];
      if (first) selectHandoff(first.handoff.id);
    }
  }, [selectedId, ordered.length]);

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
              Диалоги, переданные диспетчеру. Ответ здесь ведёт диалог до «Завершить чат».
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
            <div className="space-y-3">
              {live.length > 0 ? (
                <div>
                  <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Активные · {live.length}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {live.map((chat) => (
                      <ChatListRow
                        key={chat.handoff.id}
                        chat={chat}
                        active={chat.handoff.id === selected?.handoff.id}
                        onSelect={() => selectHandoff(chat.handoff.id)}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
              {finished.length > 0 ? (
                <div>
                  <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    Завершённые · {finished.length}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {finished.map((chat) => (
                      <ChatListRow
                        key={chat.handoff.id}
                        chat={chat}
                        active={chat.handoff.id === selected?.handoff.id}
                        onSelect={() => selectHandoff(chat.handoff.id)}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            {selected ? (
              <ChatThread
                key={selected.handoff.id}
                chat={selected}
                writesDisabled={writesDisabled}
                onSendMessage={(text) => onSendMessage(selected.conversation.id, text)}
                onFinish={() => onFinish(selected.conversation.id)}
                onMarkRead={() => onMarkRead(selected.conversation.id, lastSeqOf(selected))}
              />
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

function ChatListRow({
  chat,
  active,
  onSelect,
}: {
  readonly chat: DispatchChatView;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const finished = chat.handoff.state === 'closed';
  const answered = chat.handoff.state === 'answered';
  const last = chat.messages[chat.messages.length - 1];
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full rounded-xl px-3 py-2.5 text-left text-sm ${
          active ? 'bg-canvas' : 'hover:bg-canvas/60'
        } ${finished ? 'opacity-70' : ''}`}
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
        <span className="mt-0.5 block text-[12px] text-muted">{originLabel(chat)}</span>
        <span className="mt-0.5 block text-[12px] text-muted">
          {finished
            ? `Завершён${chat.handoff.closedAt !== null ? ` · ${formatClock(chat.handoff.closedAt)}` : ''}`
            : answered
              ? 'Ответ отправлен'
              : 'Ожидает ответа'}
        </span>
        {last ? (
          <span className="mt-0.5 block truncate text-[12px] text-muted">{last.text}</span>
        ) : null}
      </button>
    </li>
  );
}

function ChatThread({
  chat,
  writesDisabled,
  onSendMessage,
  onFinish,
  onMarkRead,
}: {
  readonly chat: DispatchChatView;
  readonly writesDisabled: boolean;
  readonly onSendMessage: (text: string) => Promise<void>;
  readonly onFinish: () => Promise<void>;
  readonly onMarkRead: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const finished = chat.handoff.state === 'closed';
  const answered = chat.handoff.state === 'answered';

  // Acknowledges up to the newest message the dispatcher is actually looking at, and only
  // when that point has moved. A once-per-mount guard would be wrong in the one case that
  // matters: a message arriving *while* the chat is open would raise the badge over a
  // conversation being read right now and leave it there until the dispatcher clicked away
  // and back. Guarding on the sequence instead keeps the call out of a render loop --
  // `onMarkRead` is a fresh closure every render, so a plain dependency on it would not.
  const lastSeen = chat.messages[chat.messages.length - 1]?.seq ?? chat.handoff.startSeq;
  const markedSeqRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: guarded by the sequence, not by identity
  useEffect(() => {
    if (chat.unreadCount > 0 && lastSeen > markedSeqRef.current) {
      markedSeqRef.current = lastSeen;
      onMarkRead();
    }
  }, [chat.unreadCount, lastSeen]);

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
      setActionError(cause instanceof Error ? cause.message : 'Не удалось завершить чат');
    } finally {
      setFinishing(false);
    }
  }

  const history = chat.messages.filter((message) => message.seq <= chat.handoff.startSeq);
  const afterHandoff = chat.messages.filter((message) => message.seq > chat.handoff.startSeq);

  return (
    <div className="flex min-h-[24rem] flex-col overflow-hidden rounded-2xl border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-canvas px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <Headset className="h-4 w-4 text-muted" />
          {finished
            ? `Чат завершён${chat.handoff.closedAt !== null ? ` · ${formatClock(chat.handoff.closedAt)}` : ''}`
            : answered
              ? 'Диалог ведёт диспетчер'
              : 'Ожидаем первого ответа диспетчера'}
        </div>
        {finished ? (
          <span className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-muted">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Только чтение
          </span>
        ) : (
          <button
            type="button"
            disabled={writesDisabled || finishing}
            onClick={() => void finish()}
            className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          >
            {finishing ? 'Завершаем…' : 'Завершить чат'}
          </button>
        )}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {chat.messages.length === 0 ? (
          <p className="text-sm text-muted">Сообщений пока нет.</p>
        ) : (
          <>
            {history.length > 0 ? (
              <>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  До передачи — адресовано ассистенту
                </p>
                {history.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    roleProfile={chat.conversation.roleProfile}
                  />
                ))}
                <p className="border-t border-dashed border-line pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Передано диспетчеру
                </p>
              </>
            ) : null}
            {afterHandoff.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                roleProfile={chat.conversation.roleProfile}
              />
            ))}
          </>
        )}
        <ChatBottomSpacer />
      </div>
      {finished ? (
        <div className="shrink-0 border-t border-line p-3 text-xs text-muted">
          Чат завершён и доступен только для чтения.
        </div>
      ) : (
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
      )}
    </div>
  );
}

function MessageBubble({
  message,
  roleProfile,
}: {
  readonly message: AiMessage;
  readonly roleProfile: AiRoleProfile;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted">
        {authorLabel(message.author, roleProfile)} · {formatClock(message.createdAt)}
      </span>
      <p className="rounded-2xl border border-line bg-white px-3 py-2 text-sm">{message.text}</p>
    </div>
  );
}
