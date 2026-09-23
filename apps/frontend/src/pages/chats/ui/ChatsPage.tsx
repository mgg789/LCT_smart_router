import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, MessagesSquare, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatTarget, DispatchChatView } from '@/entities/chat';
import {
  dispatchChatsQueryKey,
  finishChat,
  markChatRead,
  openDispatchChat,
  sendChatMessage,
  useDispatchChats,
} from '@/entities/chat';
import { useEngineers } from '@/entities/engineer';
import { useDispatchLive } from '@/entities/live';
import { useDispatchState } from '@/entities/plan';
import { useRequests } from '@/entities/request';
import { failedWithoutData, isApiError } from '@/shared/api';
import { cn, fadeSoft, formatTime, springQuick, staggered, useMotionOn } from '@/shared/lib';
import { Monogram } from '@/shared/ui';
import type { Contact, ContactKind } from '../model/contacts';
import { clientContacts, engineerContacts, filterContacts } from '../model/contacts';
import { chatForContact, chatStatus, lastSeq, threadMessages } from '../model/threads';
import { useChatStream } from '../model/useChatStream';

const TABS: Array<{ kind: ContactKind; label: string }> = [
  { kind: 'engineers', label: 'Инженеры' },
  { kind: 'clients', label: 'Клиенты' },
];

/** The two-way switch of the drawing; the dark capsule slides to the chosen side. */
function Tabs({ value, onChange }: { value: ContactKind; onChange: (kind: ContactKind) => void }) {
  const motionOn = useMotionOn();
  return (
    <div
      aria-label="Кому писать"
      className="mx-auto flex h-[51px] w-fit items-center rounded-full border-[1.5px] border-ink p-1"
      role="tablist"
    >
      {TABS.map((tab) => {
        const active = tab.kind === value;
        return (
          <button
            aria-selected={active}
            className={cn(
              'relative h-full rounded-full px-5 text-[20px] transition-colors duration-200',
              active ? 'text-white' : 'text-ink hover:text-ink/70',
            )}
            key={tab.kind}
            onClick={() => onChange(tab.kind)}
            role="tab"
            type="button"
          >
            {active ? (
              <motion.span
                className="absolute inset-0 rounded-full bg-ink"
                layoutId="chats-tab-capsule"
                transition={motionOn ? springQuick : { duration: 0 }}
              />
            ) : null}
            <span className="relative">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ContactRow({
  contact,
  selected,
  onSelect,
}: {
  contact: Contact;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-current={selected}
      className={cn(
        'relative flex w-full items-center gap-[14px] rounded-2xl px-[7px] py-[15px] text-left',
        'transition-[background-color,transform] duration-150 active:scale-[0.99]',
        selected ? 'bg-muted' : 'hover:bg-muted/60',
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="relative shrink-0">
        <Monogram name={contact.name} size={60} />
        {contact.online ? (
          <span
            aria-hidden
            className="absolute right-0 bottom-0 size-[14px] rounded-full border-2 border-surface bg-success"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-[20px] text-ink">{contact.name}</span>
        <span className="mt-1 block truncate text-[18px] text-ink-soft">{contact.status}</span>
      </span>
    </button>
  );
}

/** The message field of the drawing (95:991), now with somewhere to send to. */
function Composer({
  disabled,
  pending,
  onSend,
}: {
  disabled: boolean;
  pending: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const empty = draft.trim().length === 0;

  const submit = () => {
    if (empty || disabled || pending) return;
    onSend(draft.trim());
    setDraft('');
  };

  return (
    <form
      className="flex h-[79px] w-[595px] max-w-full items-center rounded-full bg-ink pr-2 pl-[10px]"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <button
        aria-label="Прикрепить файл"
        className="flex size-[60px] shrink-0 cursor-not-allowed items-center justify-center rounded-full bg-accent text-ink opacity-60"
        disabled
        title="Вложений в контракте чатов нет — можно отправить только текст"
        type="button"
      >
        <Plus aria-hidden size={28} strokeWidth={2.2} />
      </button>
      <label className="sr-only" htmlFor="chat-message">
        Сообщение
      </label>
      <input
        className="ml-[15px] min-w-0 flex-1 bg-transparent font-medium text-[20px] text-white outline-none placeholder:text-white/70 disabled:cursor-not-allowed"
        disabled={disabled}
        id="chat-message"
        onChange={(event) => setDraft(event.target.value)}
        placeholder={disabled ? 'Переписка завершена' : 'Отправьте сообщение'}
        value={draft}
      />
      <button
        aria-label="Отправить"
        className={cn(
          'flex size-[63px] shrink-0 items-center justify-center rounded-full text-white',
          'bg-gradient-to-b from-white/20 to-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] ring-1 ring-white/20',
          'transition-transform duration-150 enabled:active:scale-[0.95] disabled:opacity-50',
        )}
        disabled={empty || disabled || pending}
        type="submit"
      >
        <ArrowRight aria-hidden size={28} />
      </button>
    </form>
  );
}

/** One reply in the thread: the dispatcher on the right, the other side on the left. */
function Bubble({ text, mine, at }: { text: string; mine: boolean; at: number }) {
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[70%] rounded-[24px] px-6 py-[13px] text-[18px] leading-[22px]',
          mine ? 'bg-ink text-white' : 'bg-surface text-ink',
        )}
      >
        <p className="whitespace-pre-line">{text}</p>
        <p className={cn('mt-1 text-[14px]', mine ? 'text-white/60' : 'text-ink-soft')}>
          {formatTime(at)}
        </p>
      </div>
    </div>
  );
}

/**
 * «Чаты» (Figma 95:991): who to write to on the left — crews or clients — and
 * the conversation with the chosen one on the right.
 *
 * The people are real: the day's crews with what the LIVE day says about them,
 * and the clients who left a name on a request. So is the conversation now —
 * `/dispatch/chats` carries the dispatcher's side of every handover, live over
 * its own stream.
 *
 * Writing to someone who has no chat yet opens one: the browser names the object
 * (a request, an engineer) and the server finds the person behind it. A finished
 * chat stays readable and its field goes quiet rather than letting a reply look
 * delivered into a closed handover.
 */
export function ChatsPage() {
  const engineersQuery = useEngineers();
  const requestsQuery = useRequests();
  const stateQuery = useDispatchState();
  const liveQuery = useDispatchLive();
  const chatsQuery = useDispatchChats();
  const queryClient = useQueryClient();
  const motionOn = useMotionOn();
  useChatStream(true);

  const [tab, setTab] = useState<ContactKind>('engineers');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const contacts = useMemo(
    () =>
      tab === 'engineers'
        ? engineerContacts(
            engineersQuery.data?.engineers ?? [],
            liveQuery.data ?? null,
            stateQuery.data?.plan ?? null,
          )
        : clientContacts(requestsQuery.data?.requests ?? []),
    [tab, engineersQuery.data, liveQuery.data, stateQuery.data, requestsQuery.data],
  );
  const visible = filterContacts(contacts, query);
  // The first person stays chosen until the dispatcher picks someone, as drawn.
  const selected = visible.find((contact) => contact.id === selectedId) ?? visible[0] ?? null;

  const chats = chatsQuery.data?.chats ?? [];
  // A failed read is not an empty inbox: saying «переписки пока нет» here would
  // present a broken endpoint as a quiet day.
  const chatsUnread = failedWithoutData(chatsQuery);
  const chat = selected ? chatForContact(chats, selected) : null;
  const messages = threadMessages(chat);
  const closed = chat?.handoff.state === 'closed';
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: dispatchChatsQueryKey }),
    [queryClient],
  );

  // Opening a chat with unread replies is itself the acknowledgement; the cursor
  // only ever moves forward, so a stale tab cannot bring the badge back.
  useEffect(() => {
    const seq = lastSeq(chat);
    if (!chat || closed || chat.unreadCount === 0 || seq === null) return;
    void markChatRead(chat.conversation.id, seq)
      .then(refresh)
      .catch(() => undefined);
  }, [chat, closed, refresh]);

  // The newest reply is the one to read.
  useEffect(() => {
    if (messages.length > 0) endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const send = async (text: string) => {
    if (!selected) return;
    setPending(true);
    setProblem(null);
    try {
      if (chat && !closed) {
        await sendChatMessage(chat.conversation.id, text);
      } else {
        await openDispatchChat(selected.target as ChatTarget, text);
      }
      await refresh();
    } catch (error) {
      setProblem(
        isApiError(error) && error.code === 'CHAT_TARGET_UNREACHABLE'
          ? 'Писать некуда: у этого объекта нет входа в приложение — позвоните.'
          : isApiError(error) && error.code === 'AI_HANDOFF_NOT_ACTIVE'
            ? 'Передача уже завершена — обновите список и откройте чат заново.'
            : 'Не удалось отправить сообщение.',
      );
    } finally {
      setPending(false);
    }
  };

  const finish = async (target: DispatchChatView) => {
    setPending(true);
    try {
      await finishChat(target.conversation.id);
      await refresh();
    } catch {
      setProblem('Не удалось завершить передачу.');
    } finally {
      setPending(false);
    }
  };

  const failed = [engineersQuery, requestsQuery].some(failedWithoutData);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="shrink-0 font-display text-[48px] text-ink leading-none">Чаты</h1>

      <div className="mt-[27px] flex min-h-0 flex-1 gap-[175px]">
        <aside className="flex min-h-0 w-[430px] shrink-0 flex-col rounded-[20px] bg-surface p-5">
          <label className="flex h-[51px] shrink-0 items-center rounded-full bg-muted pr-1 pl-4">
            <span className="sr-only">Поиск</span>
            <input
              className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Поиск"
              type="search"
              value={query}
            />
            <span className="flex size-[43px] shrink-0 items-center justify-center rounded-full bg-ink text-white">
              <Search aria-hidden size={22} />
            </span>
          </label>

          <div className="mt-5 shrink-0">
            <Tabs onChange={setTab} value={tab} />
          </div>

          <div className="mt-5 min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
            {failed ? (
              <p className="px-2 py-6 text-[16px] text-danger">
                Не удалось прочитать список. Проверьте, что System Layer запущен.
              </p>
            ) : null}
            {!failed && visible.length === 0 ? (
              <p className="px-2 py-6 text-[16px] text-ink-soft">
                {query ? 'Никто не найден.' : 'Некому писать.'}
              </p>
            ) : null}
            <ul className="divide-y divide-muted">
              {visible.map((contact, index) => (
                <motion.li
                  animate={{ opacity: 1, y: 0 }}
                  initial={motionOn ? { opacity: 0, y: 12 } : false}
                  // Keyed by tab too, so switching lists plays the arrival again.
                  key={`${tab}:${contact.id}`}
                  transition={motionOn ? staggered(index) : { duration: 0 }}
                >
                  <ContactRow
                    contact={contact}
                    onSelect={() => setSelectedId(contact.id)}
                    selected={contact.id === selected?.id}
                  />
                </motion.li>
              ))}
            </ul>
          </div>
        </aside>

        <section
          aria-label="Переписка"
          className="flex min-h-0 min-w-0 flex-1 flex-col items-center pr-[139px]"
        >
          <AnimatePresence initial={false} mode="wait">
            {selected ? (
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="flex min-h-0 w-full max-w-[962px] flex-1 flex-col"
                exit={motionOn ? { opacity: 0, y: -8, transition: { duration: 0.12 } } : undefined}
                initial={motionOn ? { opacity: 0, y: 8 } : false}
                key={selected.id}
                transition={fadeSoft}
              >
                <header className="flex h-[66px] shrink-0 items-center gap-[14px] rounded-full bg-surface pr-6 pl-1">
                  <Monogram name={selected.name} size={58} />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate font-display text-[20px] text-ink leading-tight">
                      {selected.name}
                    </h2>
                    <p className="truncate text-[18px] text-ink-soft leading-tight">
                      {chatStatus(chat) ?? selected.status}
                    </p>
                  </div>
                  {chat && !closed ? (
                    <button
                      className="shrink-0 rounded-full border border-ink/20 px-4 py-1 text-[16px] text-ink transition-colors duration-150 hover:bg-muted disabled:opacity-50"
                      disabled={pending}
                      onClick={() => void finish(chat)}
                      type="button"
                    >
                      Завершить передачу
                    </button>
                  ) : null}
                </header>

                {messages.length === 0 ? (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
                    <MessagesSquare
                      aria-hidden
                      className="text-ink/25"
                      size={48}
                      strokeWidth={1.5}
                    />
                    {chatsUnread ? (
                      <>
                        <p className="mt-4 font-semibold text-[20px] text-ink">
                          Переписки не прочитаны
                        </p>
                        <p className="mt-2 max-w-[520px] text-[16px] text-ink-soft">
                          System Layer не отдал список чатов, поэтому неизвестно, есть ли разговор с
                          «{selected.name}». Отправленное сейчас сообщение откроет новый чат.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="mt-4 font-semibold text-[20px] text-ink">
                          Переписки пока нет
                        </p>
                        <p className="mt-2 max-w-[520px] text-[16px] text-ink-soft">
                          Напишите первым — чат с «{selected.name}» откроется на этой заявке.
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto py-6 [scrollbar-width:thin]">
                    {messages.map((message) => (
                      <li key={message.id}>
                        <Bubble
                          at={message.createdAt}
                          mine={message.author === 'dispatcher'}
                          text={message.text}
                        />
                      </li>
                    ))}
                    <div ref={endRef} />
                  </ol>
                )}

                {closed ? (
                  <p className="shrink-0 pb-2 text-center text-[16px] text-ink-soft">
                    Передача завершена — диалог вернулся к ассистенту. История сохранена.
                  </p>
                ) : null}
              </motion.div>
            ) : (
              <p className="m-auto text-[18px] text-ink-soft" key="none">
                Выберите, кому написать.
              </p>
            )}
          </AnimatePresence>

          <div className="flex shrink-0 flex-col items-center gap-2 pt-4 pb-[68px]">
            {problem ? <p className="text-[16px] text-danger">{problem}</p> : null}
            <Composer
              disabled={!selected || closed}
              onSend={(text) => void send(text)}
              pending={pending}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
