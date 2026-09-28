import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { AiMessage, AiRoleProfile, DispatchChatView } from '../api/ai';
import type { LiveWorkday } from '../api/live';
import { businessAt } from '../domain/liveClock';
import { t } from '../i18n';
import { formatClock } from '../lib/time';
import { AiMarkdown } from './AiMarkdown';
import { AnimatedCapsuleTabs } from './AnimatedCapsuleTabs';
import { AnimatedEngineerSearch } from './AnimatedEngineerSearch';
import { useArtboardStretch } from './artboardStretch';
import { ENGINEER_PORTRAITS, FIGMA_ASSETS } from './assets';
import { engineerPortrait, engineerPortraitIndex } from './engineerPortrait';
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
  readonly focusChatId?: string | null;
  readonly chats: DispatchChatView[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly writesDisabled: boolean;
  readonly onSendMessage: (conversationId: string, text: string) => Promise<void>;
  readonly onFinish: (conversationId: string) => Promise<void>;
  readonly onMarkRead: (conversationId: string, seq: number) => void;
  /** The running day, so message stamps are told on the clock the board is drawn in. */
  readonly workday?: LiveWorkday | null;
  readonly engineers: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly canChat: boolean;
  }[];
  readonly onOpenEngineer: (engineerId: string) => Promise<DispatchChatView>;
}

type SideFilter = 'engineer' | 'client';

function sideOf(profile: AiRoleProfile): SideFilter {
  return profile === 'engineer' ? 'engineer' : 'client';
}

/** Who opened this episode. The frame has no slot for it, so it only previews a row that
 *  has no message of its own yet. */
export function originLabel(chat: DispatchChatView): string {
  if (chat.handoff.initiatedBy === 'dispatcher') return t('figma-dashboard.ChatsView.e3be141751');
  return sideOf(chat.conversation.roleProfile) === 'engineer'
    ? t('figma-dashboard.ChatsView.8db0180fda')
    : t('figma-dashboard.ChatsView.cb8a5b989d');
}

function lastMessage(chat: DispatchChatView): AiMessage | undefined {
  return chat.messages[chat.messages.length - 1];
}

function lastSeqOf(chat: DispatchChatView): number {
  return lastMessage(chat)?.seq ?? chat.handoff.startSeq;
}

/** `Инженер · Алексей Волков` → `Алексей Волков`. */
const ROLE_PREFIX = /^\s*(?:Инженер|Клиент)\s*[·—–:-]\s*/u;

/**
 * The name the frame puts in bold.
 *
 * A chat opened from the board carries one in `conversation.title`, prefixed by the role.
 * The prefix is dropped here: the switch above the list already says which side is being
 * read, so repeating it on every row costs the width the name needs.
 *
 * One the assistant escalated carries nothing that names the person — no title, no
 * engineer id, no request id. That row says so rather than borrowing the role as a name.
 */
export function chatName(chat: DispatchChatView): string {
  const title = chat.conversation.title?.trim().replace(ROLE_PREFIX, '').trim();
  return title && title.length > 0 ? title : t('figma-dashboard.ChatsView.0106f3ae25');
}

/** The frame's «В сети - заявка № 1031»: the request when the chat is about one, and in
 *  every case what this dialogue is waiting for. */
export function chatStatus(chat: DispatchChatView): string {
  if (chat.handoff.state === 'closed') return t('figma-dashboard.ChatsView.85ce552746');
  const requestId = chat.handoff.requestIds[0];
  const state =
    chat.handoff.state === 'waiting'
      ? t('figma-dashboard.ChatsView.3f2ab13b35')
      : t('figma-dashboard.ChatsView.57b040aecc');
  return requestId
    ? t('figma-dashboard.ChatsView.8eb12def3b', {
        value0: state,
        value1: shortRequestId(requestId),
      })
    : state;
}

/**
 * The portrait for a chat row. Nobody in a handover carries a photo and the frame is
 * drawn with one, so an illustration is chosen — but by the same rule as everywhere
 * else, not by hashing the conversation id: an engineer kept one face in «Инженеры»
 * and a different one here, and a customer was given a member of the crew's.
 *
 * An engineer resolves to their own portrait through `engineerPortrait`. A customer has
 * no roster row, so the pool is picked from their name, which at least keeps the
 * illustration stable and consistent with how they are addressed.
 */
function portraitFor(chat: DispatchChatView): string {
  const name = chatName(chat);
  const engineerId = chat.handoff.engineerIds[0];
  if (engineerId) return engineerPortrait(engineerId, name);
  return (
    ENGINEER_PORTRAITS[engineerPortraitIndex(chat.conversation.id, name)] ?? ENGINEER_PORTRAITS[0]
  );
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
  focusChatId,
  chats,
  loading,
  error,
  writesDisabled,
  onSendMessage,
  onFinish,
  onMarkRead,
  workday = null,
  engineers,
  onOpenEngineer,
}: ChatsViewProps) {
  const { dx, dy } = useArtboardStretch();
  const reduceMotion = useReducedMotion();
  const [side, setSide] = useState<SideFilter>('engineer');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openingEngineerId, setOpeningEngineerId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    if (!focusChatId) return;
    setSelectedId(focusChatId);
    setSide('engineer');
  }, [focusChatId]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const list = chats ?? [];
    const live = list.filter((chat) => chat.handoff.state !== 'closed');
    const done = list.filter((chat) => chat.handoff.state === 'closed');
    return [...live, ...done];
  }, [chats]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((chat) => {
      if (sideOf(chat.conversation.roleProfile) !== side) return false;
      if (needle.length === 0) return true;
      const haystack = `${chatName(chat)} ${lastMessage(chat)?.text ?? ''}`;
      return haystack.toLowerCase().includes(needle);
    });
  }, [all, query, side]);

  const engineersToStart = useMemo(() => {
    if (side !== 'engineer') return [];
    const activeEngineerIds = new Set(
      all
        .filter(
          (chat) =>
            chat.handoff.state !== 'closed' && sideOf(chat.conversation.roleProfile) === 'engineer',
        )
        .flatMap((chat) => chat.handoff.engineerIds),
    );
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    return engineers.filter(
      (engineer) =>
        !activeEngineerIds.has(engineer.id) &&
        (needle.length === 0 || engineer.displayName.toLocaleLowerCase('ru-RU').includes(needle)),
    );
  }, [all, engineers, query, side]);

  const selected = rows.find((chat) => chat.handoff.id === selectedId) ?? rows[0] ?? null;
  const liveRows = rows.filter((chat) => chat.handoff.state !== 'closed');
  const closedRows = rows.filter((chat) => chat.handoff.state === 'closed');
  const displayRows = side === 'engineer' ? [...liveRows, ...closedRows] : rows;

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
          {t('figma-dashboard.ChatsView.dddf6406c8')}
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
        <AnimatedEngineerSearch
          value={query}
          onChange={setQuery}
          motionOn={!reduceMotion}
          placeholder={
            side === 'engineer'
              ? t('figma-dashboard.EngineersView.6614a726f7')
              : t('figma-dashboard.ChatsView.180f58ab97')
          }
          className="h-[51px] w-[390px] rounded-[27px] px-[16px] pr-[60px] [&>input]:font-semibold [&>input]:text-[18px] [&>input]:placeholder:text-[#727478]"
          style={{ left: 20, top: 20 }}
        />

        <AnimatedCapsuleTabs
          items={[
            { id: 'engineer' as const, label: t('figma-dashboard.ChatsView.960ef88466') },
            { id: 'client' as const, label: t('figma-dashboard.ChatsView.ff296ddaed') },
          ]}
          value={side}
          onChange={setSide}
          motionOn={!reduceMotion}
          label={t('figma-dashboard.ChatsView.cd06cc7991')}
          className="absolute left-[68px] top-[91px] h-[51px] w-[294px] rounded-[100px] border-[1.5px] border-[#727478] border-solid bg-white p-[3px]"
          textClassName="figma-nowrap font-medium text-[20px] leading-none"
        />

        <div
          className="absolute overflow-y-auto overflow-x-hidden"
          style={{ left: 13, top: 174, width: 405, height: 680 + dy }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={side}
              initial={reduceMotion ? false : { opacity: 0, x: side === 'engineer' ? -18 : 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, x: side === 'engineer' ? 18 : -18 }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              {loading &&
              all.length === 0 &&
              (side !== 'engineer' || engineersToStart.length === 0) ? (
                <FigmaText className="block pt-[24px] font-semibold text-[18px] text-[#727478]">
                  {t('figma-dashboard.ChatsView.1c1f3c812b')}
                </FigmaText>
              ) : rows.length === 0 && engineersToStart.length === 0 ? (
                <FigmaText className="block pt-[24px] font-semibold text-[18px] text-[#727478]">
                  {side === 'engineer'
                    ? t('figma-dashboard.ChatsView.ee9fa4a3f5')
                    : t('figma-dashboard.ChatsView.6e4935aea3')}
                </FigmaText>
              ) : (
                <>
                  {displayRows
                    .slice(0, side === 'engineer' ? liveRows.length : displayRows.length)
                    .map((chat, index) => (
                      <ChatRow
                        key={chat.handoff.id}
                        chat={chat}
                        top={index * ROW_STEP}
                        last={
                          index ===
                            (side === 'engineer' ? liveRows.length : displayRows.length) - 1 &&
                          engineersToStart.length === 0 &&
                          (side !== 'engineer' || closedRows.length === 0)
                        }
                        selected={selected?.handoff.id === chat.handoff.id}
                        workday={workday}
                        onSelect={() => setSelectedId(chat.handoff.id)}
                      />
                    ))}
                  {engineersToStart.map((engineer, index) => (
                    <EngineerStartRow
                      key={engineer.id}
                      engineer={engineer}
                      top={(liveRows.length + index) * ROW_STEP}
                      last={
                        index === engineersToStart.length - 1 &&
                        (side !== 'engineer' || closedRows.length === 0)
                      }
                      opening={openingEngineerId === engineer.id}
                      writesDisabled={writesDisabled}
                      onSelect={() => {
                        setOpenError(null);
                        setOpeningEngineerId(engineer.id);
                        void onOpenEngineer(engineer.id)
                          .catch((cause: unknown) => {
                            setOpenError(
                              cause instanceof Error
                                ? cause.message
                                : t('figma-dashboard.ChatsView.engineerOpenFailed'),
                            );
                          })
                          .finally(() => setOpeningEngineerId(null));
                      }}
                    />
                  ))}
                  {side === 'engineer'
                    ? closedRows.map((chat, index) => (
                        <ChatRow
                          key={chat.handoff.id}
                          chat={chat}
                          top={(liveRows.length + engineersToStart.length + index) * ROW_STEP}
                          last={index === closedRows.length - 1}
                          selected={selected?.handoff.id === chat.handoff.id}
                          workday={workday}
                          onSelect={() => setSelectedId(chat.handoff.id)}
                        />
                      ))
                    : null}
                </>
              )}
            </motion.div>
          </AnimatePresence>
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
              src={portraitFor(selected)}
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
                {t('figma-dashboard.ChatsView.14f7a99f9a')}
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
              {/* Drawn in the frame, with nothing behind it yet: shown, and plainly off. */}
              <button
                type="button"
                disabled
                aria-label={t('figma-dashboard.ChatsView.414b22e6f4')}
                title={t('figma-dashboard.ChatsView.fdf8452243')}
                className="absolute flex cursor-not-allowed items-center justify-center rounded-full bg-figma-bee opacity-40"
                style={{ left: 10, top: 10, width: 60, height: 60 }}
              >
                <FigmaIcon src={FIGMA_ASSETS.iconPlus} alt="" width={20} height={20} />
              </button>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={writesDisabled || closed}
                placeholder={
                  closed
                    ? t('figma-dashboard.ChatsView.85ce552746')
                    : t('figma-dashboard.ChatsView.c05ba20c41')
                }
                aria-label={t('figma-dashboard.ChatsView.04bbba543c')}
                className="absolute bg-transparent font-semibold text-[20px] text-[#ededed] outline-none placeholder:text-[#ededed] disabled:opacity-50"
                style={{ left: 85, right: 83, top: 0, height: 79 }}
              />
              <button
                type="submit"
                disabled={writesDisabled || sending || draft.trim().length === 0 || closed}
                aria-label={t('figma-dashboard.ChatsView.ceb68a9287')}
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
          style={{
            left: THREAD_LEFT + (THREAD_WIDTH + dx) / 2,
            top: 67 + (881 + dy) / 2,
            transform: 'translate(-50%, -50%)',
            textAlign: 'center',
          }}
        >
          {error ?? t('figma-dashboard.ChatsView.1fefed6d5c')}
        </FigmaText>
      )}

      {(error || openError) && selected ? (
        <p
          role="alert"
          className="figma-text absolute font-semibold text-[16px] text-[#d92d20]"
          style={{ left: THREAD_LEFT, top: 20 }}
        >
          {openError ?? error}
        </p>
      ) : null}
      {openError && !selected ? (
        <p
          role="alert"
          className="absolute text-[16px] text-[#d92d20]"
          style={{ left: THREAD_LEFT, top: 20 }}
        >
          {openError}
        </p>
      ) : null}
    </section>
  );
}

function ChatsTitle() {
  return (
    <FigmaText className="figma-nowrap absolute top-0 left-0 font-murs text-[40px] text-figma-ink">
      {t('figma-dashboard.ChatsView.b5121e526d')}
    </FigmaText>
  );
}

function ChatRow({
  chat,
  top,
  last,
  selected,
  workday,
  onSelect,
}: {
  chat: DispatchChatView;
  top: number;
  last: boolean;
  selected: boolean;
  workday: LiveWorkday | null;
  onSelect: () => void;
}) {
  const preview = lastMessage(chat)?.text ?? originLabel(chat);
  // Messages are stamped on the wall clock, as audit rows are; the rest of this board
  // is drawn in business time, so the row is told on the same clock as the header.
  const at = businessAt(lastMessage(chat)?.createdAt ?? chat.handoff.createdAt, workday);
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
        src={portraitFor(chat)}
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

function EngineerStartRow({
  engineer,
  top,
  last,
  opening,
  writesDisabled,
  onSelect,
}: {
  engineer: { readonly id: string; readonly displayName: string; readonly canChat: boolean };
  top: number;
  last: boolean;
  opening: boolean;
  writesDisabled: boolean;
  onSelect: () => void;
}) {
  const canStart = engineer.canChat && !writesDisabled;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={opening || !canStart}
      className="absolute block w-[390px] text-left disabled:opacity-60"
      style={{ left: 7, top, height: ROW_HEIGHT }}
    >
      <img
        alt=""
        src={engineerPortrait(engineer.id, engineer.displayName)}
        className="absolute rounded-full object-cover"
        style={{ left: 0, top: 0, width: 60, height: 60 }}
      />
      <FigmaText
        className="figma-nowrap absolute overflow-hidden text-ellipsis font-murs text-[20px] text-figma-ink"
        style={{ left: 74, top: 8, maxWidth: 262 }}
      >
        {engineer.displayName}
      </FigmaText>
      <FigmaText
        className="figma-nowrap absolute font-semibold text-[18px] text-[#727478]"
        style={{ left: 74, top: 39, maxWidth: 262 }}
      >
        {opening
          ? t('figma-dashboard.ChatsView.openingEngineer')
          : canStart
            ? t('figma-dashboard.ChatsView.startEngineerChat')
            : writesDisabled
              ? t('figma-dashboard.ChatsView.chatsReadOnly')
              : t('figma-dashboard.ChatsView.engineerChatUnavailable')}
      </FigmaText>
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
            {t('figma-dashboard.ChatsView.910778e14c')}
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
          {mine ? (
            <p className="whitespace-pre-wrap font-medium text-[20px]">{message.text}</p>
          ) : (
            /*
             * Only this side. The assistant answers in Markdown — lists, bold, code — and
             * a dispatcher typing into the box below writes plain text, which Markdown
             * would only find stray asterisks in. `AiMarkdown` already renders at the
             * frame's 20/medium on a light background, which is exactly this bubble.
             */
            <AiMarkdown text={message.text} />
          )}
        </div>
      </motion.div>
    </>
  );
}
