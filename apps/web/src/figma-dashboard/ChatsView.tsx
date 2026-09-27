import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { AiMessage, AiRoleProfile, DispatchChatView } from '../api/ai';
import { formatClock } from '../lib/time';
import { useArtboardStretch } from './artboardStretch';
import { ENGINEER_PORTRAITS, FIGMA_ASSETS } from './assets';
import { FigmaIcon, FigmaText } from './primitives';

/** Figma CHATS 95:991, in artboard units: the left card, then the thread column. */
const CARD_WIDTH = 430;
const THREAD_LEFT = 604;
const THREAD_WIDTH = 963;
const ROW_STEP = 100;
const ROW_HEIGHT = 80;
const BUBBLE_MAX = 682;

export interface ChatsViewProps {
  readonly token: string | null;
  readonly chats: DispatchChatView[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly writesDisabled: boolean;
  readonly onSendMessage: (conversationId: string, text: string) => Promise<void>;
  readonly onFinish: (conversationId: string) => Promise<void>;
  readonly onRefresh: () => void;
  readonly onMarkRead: (conversationId: string, seq: number) => void;
}

type SideFilter = 'engineer' | 'client';

/** Which side of a `user` message spoke: `AiMessageAuthor` knows the role, not the person. */
function sideOf(profile: AiRoleProfile): SideFilter {
  return profile === 'engineer' ? 'engineer' : 'client';
}

/** Who opened this episode. The board shows it because a chat the dispatcher started
 *  needs no answer, and one the other side asked for does. */
export function originLabel(chat: DispatchChatView): string {
  if (chat.handoff.initiatedBy === 'dispatcher') return 'Вы написали первым';
  return sideOf(chat.conversation.roleProfile) === 'engineer'
    ? 'Инженер попросил диспетчера'
    : 'Клиент попросил диспетчера';
}

/** The newest line, which is what a list row previews. */
function lastMessage(chat: DispatchChatView): AiMessage | undefined {
  return chat.messages[chat.messages.length - 1];
}

/** The seq to mark a chat read up to: its newest message, or the handover's own cursor. */
function lastSeqOf(chat: DispatchChatView): number {
  return lastMessage(chat)?.seq ?? chat.handoff.startSeq;
}

/**
 * A stable portrait per conversation. The API carries no photo for either side, and the
 * frame is drawn with one, so the pool is cycled by id rather than by list position —
 * a row must not change face when the list reorders around it.
 */
function portraitFor(id: string): string {
  let sum = 0;
  for (let index = 0; index < id.length; index += 1) sum += id.charCodeAt(index);
  return ENGINEER_PORTRAITS[sum % ENGINEER_PORTRAITS.length] as string;
}

/** The name the counterpart is listed under. The handover carries no display name, so
 *  the role and the short conversation id are what honestly identifies a row. */
function titleOf(chat: DispatchChatView): string {
  return sideOf(chat.conversation.roleProfile) === 'engineer' ? 'Инженер' : 'Клиент';
}

function subtitleOf(chat: DispatchChatView): string {
  if (chat.handoff.state === 'closed') return 'Чат завершён';
  return chat.handoff.state === 'waiting' ? 'Ожидает ответа' : 'Диалог ведёт диспетчер';
}

/**
 * Figma CHATS 95:991 — the dispatcher's handed-over dialogues on the MAIN artboard.
 *
 * Two columns as drawn: a 430-wide card holding search, an «Инженеры / Клиенты» switch
 * and the rows, and a thread beside it with a header strip, the messages and one composer
 * centred under them. Spare board height goes to both columns; spare width to the thread,
 * which is the one part that reads better wider.
 *
 * Rows are keyed by `handoff.id`, not `conversation.id`: the same person can be handed
 * over several times in a day and each episode is its own row.
 */
export function ChatsView({
  token,
  chats,
  loading,
  error,
  writesDisabled,
  onSendMessage,
  onFinish,
  onRefresh,
  onMarkRead,
}: ChatsViewProps) {
  const { dx, dy } = useArtboardStretch();
  const reduceMotion = useReducedMotion();
  const [sidePicked, setSidePicked] = useState<SideFilter | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const list = chats ?? [];
    const live = list.filter((chat) => chat.handoff.state !== 'closed');
    const done = list.filter((chat) => chat.handoff.state === 'closed');
    return [...live, ...done];
  }, [chats]);

  /*
   * Which side the switch starts on is derived, not stored: the tab should open on the
   * side that actually has someone waiting, and an effect that corrects it afterwards
   * would paint an empty «Инженеры» first and would not survive a server render.
   */
  const side: SideFilter =
    sidePicked ??
    sideOf(
      (all.find((chat) => chat.handoff.state === 'waiting') ?? all[0])?.conversation.roleProfile ??
        'engineer',
    );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((chat) => {
      if (sideOf(chat.conversation.roleProfile) !== side) return false;
      if (needle.length === 0) return true;
      const haystack = `${titleOf(chat)} ${originLabel(chat)} ${lastMessage(chat)?.text ?? ''}`;
      return haystack.toLowerCase().includes(needle);
    });
  }, [all, query, side]);

  const selected = rows.find((chat) => chat.handoff.id === selectedId) ?? rows[0] ?? null;

  useEffect(() => {
    if (!selected || selected.unreadCount === 0) return;
    onMarkRead(selected.conversation.id, lastSeqOf(selected));
  }, [selected, onMarkRead]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the newest line
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [selected?.messages.length, selected?.handoff.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!selected || text.length === 0 || sending || writesDisabled) return;
    setSending(true);
    setDraft('');
    try {
      await onSendMessage(selected.conversation.id, text);
    } finally {
      setSending(false);
    }
  }

  if (token === null) {
    return (
      <section className="absolute" style={{ left: 180, top: 100, width: 1710 + dx }}>
        <ChatsTitle />
        <FigmaText
          className="absolute left-0 font-semibold text-[20px] text-figma-muted"
          style={{ top: 90 }}
        >
          Чаты доступны только в живом контуре — подключитесь к рабочему серверу.
        </FigmaText>
      </section>
    );
  }

  return (
    <section
      className="absolute"
      style={{ left: 180, top: 100, width: 1710 + dx, height: 948 + dy }}
    >
      <ChatsTitle />
      <button
        type="button"
        onClick={onRefresh}
        className="absolute flex items-center rounded-full bg-white font-semibold text-[16px] text-figma-ink"
        style={{ left: 336, top: 108, height: 40, paddingInline: 22, gap: 8 }}
      >
        Обновить
      </button>

      {/* Left card: search, the side switch, and the rows. */}
      <div
        className="absolute overflow-hidden rounded-[30px] bg-white"
        style={{ left: 0, top: 67, width: CARD_WIDTH, height: 881 + dy }}
      >
        <label
          className="absolute flex items-center rounded-[27px] bg-figma-canvas"
          style={{ left: 20, top: 20, width: 390, height: 51, paddingLeft: 16, paddingRight: 60 }}
        >
          <span className="sr-only">Поиск по чатам</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск"
            className="figma-nowrap w-full bg-transparent font-semibold text-[16px] text-figma-ink outline-none placeholder:text-figma-muted"
          />
        </label>
        <span
          className="pointer-events-none absolute flex items-center justify-center rounded-full bg-figma-ink"
          style={{ left: 363, top: 24, width: 43, height: 43 }}
        >
          <FigmaIcon src={FIGMA_ASSETS.searchPanel} alt="" width={22} height={22} />
        </span>

        <div
          className="absolute flex items-center rounded-[27px] bg-figma-canvas"
          style={{ left: 68, top: 91, width: 294, height: 51, padding: 8 }}
          role="tablist"
          aria-label="Сторона диалога"
        >
          {(
            [
              ['engineer', 'Инженеры'],
              ['client', 'Клиенты'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={side === id}
              onClick={() => setSidePicked(id)}
              className={`relative flex h-[35px] w-[139px] items-center justify-center rounded-[20px] font-semibold text-[15px] ${
                side === id ? 'text-white' : 'text-figma-ink'
              }`}
            >
              {side === id ? (
                <motion.span
                  layoutId="chats-side-pill"
                  className="absolute inset-0 rounded-[20px] bg-figma-ink"
                  transition={
                    reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }
                  }
                />
              ) : null}
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>

        <div
          className="absolute overflow-y-auto"
          style={{ left: 20, top: 174, width: 390, height: 680 + dy }}
        >
          {loading && all.length === 0 ? (
            <FigmaText className="block pt-[24px] font-semibold text-[16px] text-figma-muted">
              Загружаем чаты…
            </FigmaText>
          ) : rows.length === 0 ? (
            <FigmaText className="block pt-[24px] font-semibold text-[16px] text-figma-muted">
              {side === 'engineer' ? 'С инженерами диалогов нет.' : 'С клиентами диалогов нет.'}
            </FigmaText>
          ) : (
            rows.map((chat, index) => (
              <ChatRow
                key={chat.handoff.id}
                chat={chat}
                top={index * ROW_STEP}
                last={index === rows.length - 1}
                selected={selected?.handoff.id === chat.handoff.id}
                onSelect={() => setSelectedId(chat.handoff.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Thread. */}
      {selected ? (
        <>
          <div
            className="absolute flex items-center rounded-[30px] bg-white"
            style={{ left: THREAD_LEFT, top: 67, width: THREAD_WIDTH + dx, height: 66, padding: 6 }}
          >
            <img
              alt=""
              src={portraitFor(selected.conversation.id)}
              className="shrink-0 rounded-full object-cover"
              style={{ width: 54, height: 54 }}
            />
            <div className="min-w-0" style={{ marginLeft: 14 }}>
              <FigmaText className="figma-nowrap font-extrabold text-[18px] tracking-[-0.306px] text-figma-ink">
                {titleOf(selected)} · {originLabel(selected)}
              </FigmaText>
              <FigmaText
                className="figma-nowrap font-semibold text-[16px] text-figma-muted"
                style={{ marginTop: 6 }}
              >
                {subtitleOf(selected)}
              </FigmaText>
            </div>
            <span className="flex-1" />
            {selected.handoff.state !== 'closed' ? (
              <button
                type="button"
                disabled={writesDisabled}
                onClick={() => void onFinish(selected.conversation.id)}
                className="shrink-0 rounded-full bg-figma-canvas font-semibold text-[15px] text-figma-ink disabled:opacity-50"
                style={{ height: 43, paddingInline: 22, marginRight: 10 }}
              >
                Завершить чат
              </button>
            ) : null}
          </div>

          <div
            ref={scrollRef}
            className="absolute overflow-y-auto"
            style={{ left: THREAD_LEFT, top: 157, width: THREAD_WIDTH + dx, height: 620 + dy }}
          >
            <div className="flex flex-col" style={{ gap: 40 }}>
              <AnimatePresence initial={false}>
                {selected.messages.map((message) => (
                  <Bubble key={message.id} message={message} motionOn={!reduceMotion} />
                ))}
              </AnimatePresence>
            </div>
          </div>

          <form
            onSubmit={submit}
            className="absolute"
            style={{
              left: THREAD_LEFT + (THREAD_WIDTH + dx - 596) / 2,
              top: 801 + dy,
              width: 596,
            }}
          >
            <div
              className="flex items-center rounded-[40px] bg-figma-ink"
              style={{ height: 79, paddingLeft: 10, paddingRight: 8, gap: 15 }}
            >
              <span
                className="flex shrink-0 items-center justify-center rounded-full bg-figma-bee"
                style={{ width: 60, height: 60 }}
              >
                <FigmaIcon src={FIGMA_ASSETS.iconPlus} alt="" width={20} height={20} />
              </span>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={writesDisabled || selected.handoff.state === 'closed'}
                placeholder={
                  selected.handoff.state === 'closed' ? 'Чат завершён' : 'Отправьте сообщение'
                }
                aria-label="Ответить в диалог"
                className="min-w-0 flex-1 bg-transparent font-semibold text-[17px] text-white outline-none placeholder:text-[#d9d9d9] disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={
                  writesDisabled ||
                  sending ||
                  draft.trim().length === 0 ||
                  selected.handoff.state === 'closed'
                }
                aria-label="Отправить"
                className="flex shrink-0 items-center justify-center rounded-full bg-white/10 disabled:opacity-40"
                style={{ width: 63, height: 63 }}
              >
                <FigmaIcon src={FIGMA_ASSETS.arrowRightWhite} alt="" width={30} height={30} />
              </button>
            </div>
          </form>
        </>
      ) : (
        <FigmaText
          className="absolute font-semibold text-[20px] text-figma-muted"
          style={{ left: THREAD_LEFT, top: 90 }}
        >
          {error ?? 'Выберите диалог слева.'}
        </FigmaText>
      )}

      {error && selected ? (
        <p
          role="alert"
          className="figma-text absolute font-semibold text-[16px] text-[#d92d20]"
          style={{ left: THREAD_LEFT, top: 20 }}
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ChatsTitle() {
  return (
    <FigmaText className="figma-nowrap absolute left-0 top-0 font-extrabold text-[40px] tracking-[-0.68px] text-figma-ink">
      Чаты
    </FigmaText>
  );
}

function ChatRow({
  chat,
  top,
  last,
  selected,
  onSelect,
}: {
  chat: DispatchChatView;
  top: number;
  last: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const preview = lastMessage(chat)?.text ?? originLabel(chat);
  const at = lastMessage(chat)?.createdAt ?? chat.handoff.createdAt;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className="absolute left-0 flex w-[390px] items-start text-left"
      style={{ top, height: ROW_HEIGHT }}
    >
      {selected ? (
        <span
          aria-hidden
          className="absolute rounded-[20px] bg-figma-canvas"
          style={{ left: -7, top: -6, width: 405, height: 91 }}
        />
      ) : null}
      <img
        alt=""
        src={portraitFor(chat.conversation.id)}
        className="relative shrink-0 rounded-full object-cover"
        style={{ width: 60, height: 60 }}
      />
      <span className="relative min-w-0 flex-1 overflow-hidden" style={{ marginLeft: 14 }}>
        <FigmaText className="figma-nowrap block font-extrabold text-[18px] tracking-[-0.306px] text-figma-ink">
          {titleOf(chat)}
        </FigmaText>
        <FigmaText
          className="figma-nowrap block overflow-hidden text-ellipsis font-semibold text-[16px] text-figma-muted"
          style={{ marginTop: 9, maxWidth: 255 }}
        >
          {preview}
        </FigmaText>
      </span>
      <span className="relative flex shrink-0 flex-col items-end" style={{ width: 44 }}>
        <FigmaText className="figma-nowrap font-semibold text-[15px] text-figma-muted">
          {formatClock(at)}
        </FigmaText>
        {chat.unreadCount > 0 ? (
          <span
            className="flex items-center justify-center rounded-full bg-figma-bee font-extrabold text-[15px] text-figma-ink"
            style={{ marginTop: 7, width: 28, height: 28 }}
          >
            {chat.unreadCount}
          </span>
        ) : null}
      </span>
      {last ? null : (
        <span
          aria-hidden
          className="absolute bg-[rgba(158,158,158,0.3)]"
          style={{ left: 0, top: ROW_HEIGHT, width: 390, height: 1 }}
        />
      )}
    </button>
  );
}

/**
 * The dispatcher's own words are dark and right-aligned; everything arriving from the
 * other side — the person, the assistant before the handover, a system line — is white
 * and left-aligned, so one glance tells who is speaking without reading a label.
 */
function Bubble({ message, motionOn }: { message: AiMessage; motionOn: boolean }) {
  const mine = message.author === 'dispatcher';
  return (
    <motion.div
      className={`flex w-full ${mine ? 'justify-end' : 'justify-start'}`}
      initial={motionOn ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionOn ? { duration: 0.24, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <div
        className={mine ? 'bg-figma-ink text-white' : 'bg-white text-figma-ink'}
        style={{ maxWidth: BUBBLE_MAX, borderRadius: 20, padding: '18px 24px' }}
      >
        {message.author === 'assistant' || message.author === 'system' ? (
          <FigmaText
            className={`block font-semibold text-[13px] uppercase tracking-[0.08em] ${
              mine ? 'text-white/60' : 'text-figma-muted'
            }`}
            style={{ marginBottom: 6 }}
          >
            {message.author === 'assistant' ? 'Ассистент' : 'Система'}
          </FigmaText>
        ) : null}
        <p className="whitespace-pre-wrap font-semibold text-[18px]" style={{ lineHeight: '22px' }}>
          {message.text}
        </p>
      </div>
    </motion.div>
  );
}
