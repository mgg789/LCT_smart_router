import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, MessagesSquare, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useEngineers } from '@/entities/engineer';
import { useDispatchLive } from '@/entities/live';
import { useDispatchState } from '@/entities/plan';
import { useRequests } from '@/entities/request';
import { failedWithoutData } from '@/shared/api';
import { cn, fadeSoft, springQuick, staggered, useMotionOn } from '@/shared/lib';
import { Monogram } from '@/shared/ui';
import type { Contact, ContactKind } from '../model/contacts';
import { clientContacts, engineerContacts, filterContacts } from '../model/contacts';

const TABS: Array<{ kind: ContactKind; label: string }> = [
  { kind: 'engineers', label: 'Инженеры' },
  { kind: 'clients', label: 'Клиенты' },
];

/** Why nothing can be written or read here yet — said once, the same everywhere. */
const NO_CONTRACT = 'Переписки нет: в System Layer нет контракта на чаты';

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

/** The message field of the drawing (95:991), off until there is somewhere to send to. */
function Composer() {
  return (
    <div
      className="flex h-[79px] w-[595px] max-w-full items-center rounded-full bg-ink pr-2 pl-[10px] opacity-90"
      title={NO_CONTRACT}
    >
      <button
        aria-label="Прикрепить файл"
        className="flex size-[60px] shrink-0 cursor-not-allowed items-center justify-center rounded-full bg-accent text-ink"
        disabled
        type="button"
      >
        <Plus aria-hidden size={28} strokeWidth={2.2} />
      </button>
      <label className="sr-only" htmlFor="chat-message">
        Сообщение
      </label>
      <input
        className="ml-[15px] min-w-0 flex-1 cursor-not-allowed bg-transparent font-medium text-[20px] text-white outline-none placeholder:text-white"
        disabled
        id="chat-message"
        placeholder="Отправьте сообщение"
      />
      <button
        aria-label="Отправить"
        className="flex size-[63px] shrink-0 cursor-not-allowed items-center justify-center rounded-full bg-gradient-to-b from-white/20 to-white/[0.05] text-white opacity-60 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] ring-1 ring-white/20"
        disabled
        type="button"
      >
        <ArrowRight aria-hidden size={28} />
      </button>
    </div>
  );
}

/**
 * «Чаты» (Figma 95:991): who to write to on the left — crews or clients — and
 * the conversation with the chosen one on the right.
 *
 * The people are real: the day's crews with what the LIVE day says about them,
 * and the clients who left a name on a request. The conversation is not: the
 * System Layer has no chat contract, so there are no messages to show and none
 * can be sent. The thread says so, and the field stays off rather than letting a
 * message look delivered that went nowhere.
 */
export function ChatsPage() {
  const engineersQuery = useEngineers();
  const requestsQuery = useRequests();
  const stateQuery = useDispatchState();
  const liveQuery = useDispatchLive();
  const motionOn = useMotionOn();

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
                  <div className="min-w-0">
                    <h2 className="truncate font-display text-[20px] text-ink leading-tight">
                      {selected.name}
                    </h2>
                    <p className="truncate text-[18px] text-ink-soft leading-tight">
                      {selected.status}
                    </p>
                  </div>
                </header>

                <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
                  <MessagesSquare aria-hidden className="text-ink/25" size={48} strokeWidth={1.5} />
                  <p className="mt-4 font-semibold text-[20px] text-ink">Переписки пока нет</p>
                  <p className="mt-2 max-w-[520px] text-[16px] text-ink-soft">
                    В System Layer нет контракта на чаты: сообщения нельзя ни прочитать, ни
                    отправить. Когда он появится, разговор с «{selected.name}» будет здесь.
                  </p>
                </div>
              </motion.div>
            ) : (
              <p className="m-auto text-[18px] text-ink-soft" key="none">
                Выберите, кому написать.
              </p>
            )}
          </AnimatePresence>

          <div className="shrink-0 pt-4 pb-[68px]">
            <Composer />
          </div>
        </section>
      </div>
    </div>
  );
}
