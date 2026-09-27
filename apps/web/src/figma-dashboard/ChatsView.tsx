import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { AiMessage, AiRoleProfile, DispatchChatView } from '../api/ai';
import { formatClock } from '../lib/time';
import { useArtboardStretch } from './artboardStretch';
import { ENGINEER_PORTRAITS, FIGMA_ASSETS } from './assets';
import { FigmaIcon, FigmaText } from './primitives';
import { shortRequestId } from './requestsTable';

/** Figma CHATS 95:991, in artboard units. */
const CARD_WIDTH = 430;
const THREAD_LEFT = 604;
const THREAD_WIDTH = 963;
const ROW_STEP = 100;
const ROW_HEIGHT = 80;
const BUBBLE_MAX = 682;
const COMPOSER_WIDTH = 596;
const HAIRLINE = 'rgba(114,116,120,0.25)';

export interface ChatsViewProps {
  readonly token: string | null;
  readonly chats: DispatchChatView[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly writesDisabled: boolean;
  readonly onSendMessage: (conversationId: string, text: string) => Promise<void>;
  readonly onFinish: (conversationId: string) => Promise<void>;
  readonly onMarkRead: (conversationId: string, seq: number) => void;
}

type SideFilter = 'engineer' | 'client';

function sideOf(profile: AiRoleProfile): SideFilter {
  return profile === 'engineer' ? 'engineer' : 'client';
}

/** Who opened this episode. The frame has no slot for it, so it only previews a row that
 *  has no message of its own yet. */
export function originLabel(chat: DispatchChatView): string {
  if (chat.handoff.initiatedBy === 'dispatcher') return 'Вы написали первым';
  return sideOf(chat.conversation.roleProfile) === 'engineer'
    ? 'Инженер попросил диспетчера'
    : 'Клиент попросил диспетчера';
}

function lastMessage(chat: DispatchChatView): AiMessage | undefined {
  return chat.messages[chat.messages.length - 1];
}

function lastSeqOf(chat: DispatchChatView): number {
  return lastMessage(chat)?.seq ?? chat.handoff.startSeq;
}

/**
 * The name the frame puts in bold.
 *
 * A chat opened from the board carries one in `conversation.title` («Инженер · Алексей
 * Волков»). One the assistant escalated carries nothing that names the person — no title,
 * no engineer id, no request id — so the role is what can honestly be shown there rather
 * than a name invented to fill the slot.
 */
export function chatName(chat: DispatchChatView): string {
  const title = chat.conversation.title?.trim();
  if (title) return title;
  return sideOf(chat.conversation.roleProfile) === 'engineer' ? 'Инженер' : 'Клиент';
}

/** The frame's «В сети - заявка № 1031»: the request when the chat is about one, and in
 *  every case what this dialogue is waiting for. */
export function chatStatus(chat: DispatchChatView): string {
  if (chat.handoff.state === 'closed') return 'Чат завершён';
  const requestId = chat.handoff.requestIds[0];
  const state = chat.handoff.state === 'waiting' ? 'Ожидает ответа' : 'Диалог ведёт диспетчер';
  return requestId ? `${state} · заявка № ${shortRequestId(requestId)}` : state;
}

/**
 * A stable portrait per conversation. Neither side of a handover carries a photo and the
 * frame is drawn with one, so the pool is cycled by id rather than by list position — a
 * row must not change face when the list reorders around it.
 */
function portraitFor(id: string): string {
  let sum = 0;
  for (let index = 0; index < id.length; index += 1) sum += id.charCodeAt(index);
  return ENGINEER_PORTRAITS[sum % ENGINEER_PORTRAITS.length] as string;
}

/**
 * Figma CHATS 95:991 — the dispatcher's handed-over dialogues on the MAIN artboard.
 *
 * Drawn as the frame has it: a 430-wide card with search, an «Инженеры / Клиенты» switch
 * and 80-unit rows on a 100 step; beside it a 963-wide thread with a header strip, the
 * messages, and one 596-wide composer centred under them. Spare board height goes to both
 * columns, spare width to the thread.
 *
 * Two things the frame does not draw, and why they are here anyway. «Завершить чат» is the
 * only way to hand a dialogue back to the assistant, and it sits in the free right half of
 * the header strip. And a divider marks where the handover began: everything above it was
 * addressed to the assistant, and without the mark it reads as words said to a dispatcher
 * who was not there yet.
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
   * side that actually has someone waiting, and an effect correcting it afterwards would
   * paint an empty «Инженеры» first and would not survive a server render.
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
      const haystack = `${chatName(chat)} ${lastMessage(chat)?.text ?? ''}`;
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
          className="absolute left-0 font-semibold text-[20px] text-[#727478]"
          style={{ top: 90 }}
        >
          Чаты доступны только в живом контуре — подключитесь к рабочему серверу.
        </FigmaText>
      </section>
    );
  }

  const closed = selected?.handoff.state === 'closed';

  return (
    <section
      className="absolute"
      style={{ left: 180, top: 100, width: 1710 + dx, height: 948 + dy }}
    >
      <ChatsTitle />

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
            className="figma-nowrap w-full bg-transparent font-semibold text-[18px] text-figma-ink outline-none placeholder:text-[#727478]"
          />
        </label>
        <span
          className="pointer-events-none absolute flex items-center justify-center rounded-full bg-figma-ink"
          style={{ left: 363, top: 24, width: 43, height: 43 }}
        >
          <FigmaIcon src={FIGMA_ASSETS.searchPanel} alt="" width={22} height={22} />
        </span>

        <div
          role="tablist"
          aria-label="Сторона диалога"
          className="absolute flex items-center justify-center rounded-[100px] border-[1.5px] border-[#727478] border-solid"
          style={{ left: 68, top: 91, width: 294, height: 51, gap: 20 }}
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
              className={`figma-nowrap flex items-center font-medium text-[20px] leading-none ${
                side === id
                  ? 'rounded-[100px] border-[0.5px] border-[#727478] border-solid bg-figma-ink text-white'
                  : 'rounded-[10px] bg-white text-figma-ink'
              }`}
              style={side === id ? { padding: '10px 20px' } : { padding: 10 }}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          className="absolute overflow-y-auto overflow-x-hidden"
          style={{ left: 13, top: 174, width: 405, height: 680 + dy }}
        >
          {loading && all.length === 0 ? (
            <FigmaText className="block pt-[24px] font-semibold text-[18px] text-[#727478]">
              Загружаем чаты…
            </FigmaText>
          ) : rows.length === 0 ? (
            <FigmaText className="block pt-[24px] font-semibold text-[18px] text-[#727478]">
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
            <span className="min-w-0" style={{ marginLeft: 14 }}>
              <FigmaText className="figma-nowrap block font-murs text-[20px] text-figma-ink">
                {chatName(selected)}
              </FigmaText>
              <FigmaText
                className="figma-nowrap block font-semibold text-[18px] text-[#727478]"
                style={{ marginTop: 5 }}
              >
                {chatStatus(selected)}
              </FigmaText>
            </span>
            <span className="flex-1" />
            {closed ? null : (
              <button
                type="button"
                disabled={writesDisabled}
                onClick={() => void onFinish(selected.conversation.id)}
                className="shrink-0 rounded-full bg-figma-canvas font-semibold text-[16px] text-figma-ink disabled:opacity-50"
                style={{ height: 43, paddingInline: 22, marginRight: 10 }}
              >
                Завершить чат
              </button>
            )}
          </div>

          <div
            ref={scrollRef}
            className="absolute overflow-y-auto"
            style={{ left: THREAD_LEFT, top: 157, width: THREAD_WIDTH + dx, height: 620 + dy }}
          >
            <div className="flex flex-col" style={{ gap: 40 }}>
              <AnimatePresence initial={false}>
                {selected.messages.map((message, index) => (
                  <Bubble
                    key={message.id}
                    message={message}
                    motionOn={!reduceMotion}
                    handoverStartsHere={
                      index > 0 &&
                      message.seq > selected.handoff.startSeq &&
                      (selected.messages[index - 1]?.seq ?? 0) <= selected.handoff.startSeq
                    }
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>

          <form
            onSubmit={submit}
            className="absolute"
            style={{
              left: THREAD_LEFT + (THREAD_WIDTH + dx - COMPOSER_WIDTH) / 2,
              top: 801 + dy,
              width: COMPOSER_WIDTH,
            }}
          >
            <div
              className="relative overflow-hidden rounded-[200px] bg-figma-ink"
              style={{ height: 79 }}
            >
              <span
                className="absolute flex items-center justify-center rounded-full bg-figma-bee"
                style={{ left: 10, top: 10, width: 60, height: 60 }}
              >
                <FigmaIcon src={FIGMA_ASSETS.iconPlus} alt="" width={20} height={20} />
              </span>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={writesDisabled || closed}
                placeholder={closed ? 'Чат завершён' : 'Отправьте сообщение'}
                aria-label="Ответить в диалог"
                className="absolute bg-transparent font-semibold text-[20px] text-[#ededed] outline-none placeholder:text-[#ededed] disabled:opacity-50"
                style={{ left: 85, right: 83, top: 0, height: 79 }}
              />
              <button
                type="submit"
                disabled={writesDisabled || sending || draft.trim().length === 0 || closed}
                aria-label="Отправить"
                className="absolute flex items-center justify-center rounded-full bg-[rgba(255,255,255,0.06)] disabled:opacity-40"
                style={{ right: 10, top: 8, width: 63, height: 63 }}
              >
                <FigmaIcon src={FIGMA_ASSETS.arrowRightWhite} alt="" width={30} height={31} />
              </button>
            </div>
          </form>
        </>
      ) : (
        <FigmaText
          className="absolute font-semibold text-[20px] text-[#727478]"
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
    <FigmaText className="figma-nowrap absolute top-0 left-0 font-murs text-[40px] text-figma-ink">
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
      className="absolute block w-[390px] text-left"
      style={{ left: 7, top, height: ROW_HEIGHT }}
    >
      {/* 405 against the row's 390: the frame lets the highlight breathe past the row. */}
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
        className="absolute rounded-full object-cover"
        style={{ left: 0, top: 0, width: 60, height: 60 }}
      />
      <FigmaText
        className="figma-nowrap absolute overflow-hidden text-ellipsis font-murs text-[20px] text-figma-ink"
        style={{ left: 74, top: 8, maxWidth: 262 }}
      >
        {chatName(chat)}
      </FigmaText>
      <FigmaText
        className="figma-nowrap absolute overflow-hidden text-ellipsis font-semibold text-[18px] text-[#727478]"
        style={{ left: 74, top: 39, maxWidth: 262 }}
      >
        {preview}
      </FigmaText>
      <FigmaText
        className="figma-nowrap absolute font-semibold text-[16px] text-[#555]"
        style={{ left: 346, top: 9 }}
      >
        {formatClock(at)}
      </FigmaText>
      {chat.unreadCount > 0 ? (
        <span
          className="absolute flex items-center justify-center rounded-full bg-figma-bee font-bold text-[16px] text-figma-ink"
          style={{ left: 354, top: 28, width: 28, height: 28 }}
        >
          {chat.unreadCount}
        </span>
      ) : null}
      {last ? null : (
        <span
          aria-hidden
          className="absolute"
          style={{ left: 0, top: ROW_HEIGHT, width: 390, height: 1, background: HAIRLINE }}
        />
      )}
    </button>
  );
}

/**
 * The dispatcher's own words are dark and to the right; everything arriving from the other
 * side is white and to the left, so one glance tells who is speaking without a label.
 */
function Bubble({
  message,
  motionOn,
  handoverStartsHere,
}: {
  message: AiMessage;
  motionOn: boolean;
  handoverStartsHere: boolean;
}) {
  const mine = message.author === 'dispatcher';
  return (
    <>
      {handoverStartsHere ? (
        <div className="flex items-center" style={{ gap: 16 }}>
          <span className="flex-1" style={{ height: 1, background: HAIRLINE }} />
          <FigmaText className="figma-nowrap font-semibold text-[15px] text-[#727478] uppercase tracking-[0.08em]">
            Передано диспетчеру
          </FigmaText>
          <span className="flex-1" style={{ height: 1, background: HAIRLINE }} />
        </div>
      ) : null}
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
          <p className="whitespace-pre-wrap font-medium text-[20px]">{message.text}</p>
        </div>
      </motion.div>
    </>
  );
}
