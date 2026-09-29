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
const HAIRLINE = 'rgba(114,116,120,0.25)';

/** Join and leave notes from before dividers replaced them. They are not part of the stream. */
const HANDOFF_NOISE = [
  'Диспетчер подключился к чату.',
  'Диспетчер завершил чат.',
];

export interface ChatsViewProps {
  readonly token: string | null;
  readonly focusChatId?: string | null;
  /** Engineer chosen from the roster. Opens their existing chat, or a draft until a message is sent. */
  readonly focusEngineerId?: string | null;
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
  readonly onOpenEngineer: (engineerId: string, text: string) => Promise<DispatchChatView>;
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

function isHandoffNoise(text: string): boolean {
  return HANDOFF_NOISE.some((noise) => text.startsWith(noise));
}

/** A line said while this chat was actually with the dispatcher. Assistant talk before
 *  the handover, and after it is handed back, does not count. */
function handoffMessage(chat: DispatchChatView): AiMessage | undefined {
  const start = chat.handoff.startSeq;
  const end = chat.handoff.endSeq;
  const inWindow = chat.messages.filter(
    (message) =>
      message.seq > start &&
      (end === null || message.seq <= end) &&
      !isHandoffNoise(message.text),
  );
  return inWindow[inWindow.length - 1];
}

function lastMessage(chat: DispatchChatView): AiMessage | undefined {
  return handoffMessage(chat) ?? chat.messages[chat.messages.length - 1];
}

function lastSeqOf(chat: DispatchChatView): number {
  return chat.messages[chat.messages.length - 1]?.seq ?? chat.handoff.startSeq;
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
  if (chat.handoff.state === 'closed' || chat.conversation.mode === 'ai') {
    return t('figma-dashboard.ChatsView.assistantLeads');
  }
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
 * The portrait for a chat row. An engineer keeps the same face as on the roster.
 * A customer has no roster row, so the pool is picked from their name rather than
 * borrowing a crew member's portrait.
 */
function portraitForChat(chat: DispatchChatView): string {
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
 * messages, and a composer the same width as that header. Spare board height goes to both
 * columns, spare width to the thread.
 *
 * «Завершить чат» hands the dialogue back to the assistant without starting a second chat:
 * one person is one row, ordered by the last message, and the next message from the
 * dispatcher joins that same row again.
 */
export function ChatsView({
  token,
  focusChatId,
  focusEngineerId,
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
  const [pendingEngineer, setPendingEngineer] = useState<{
    readonly id: string;
    readonly displayName: string;
  } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    if (!focusChatId) return;
    setPendingEngineer(null);
    setSelectedId(focusChatId);
    setSide('engineer');
  }, [focusChatId]);
  useEffect(() => {
    if (!focusEngineerId) return;
    const existing = (chats ?? []).find((chat) =>
      chat.handoff.engineerIds.includes(focusEngineerId),
    );
    if (existing) {
      setPendingEngineer(null);
      setSelectedId(existing.handoff.id);
      setSide('engineer');
      return;
    }
    const engineer = engineers.find((item) => item.id === focusEngineerId);
    if (!engineer) return;
    setSelectedId(null);
    setPendingEngineer({ id: engineer.id, displayName: engineer.displayName });
    setSide('engineer');
  }, [focusEngineerId, chats, engineers]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const list = chats ?? [];
    return [...list].sort((left, right) => {
      const leftAt = handoffMessage(left)?.createdAt ?? left.handoff.createdAt;
      const rightAt = handoffMessage(right)?.createdAt ?? right.handoff.createdAt;
      if (rightAt !== leftAt) return rightAt - leftAt;
      return left.conversation.id.localeCompare(right.conversation.id);
    });
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
        .filter((chat) => sideOf(chat.conversation.roleProfile) === 'engineer')
        .flatMap((chat) => chat.handoff.engineerIds),
    );
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    return engineers.filter(
      (engineer) =>
        !activeEngineerIds.has(engineer.id) &&
        (needle.length === 0 || engineer.displayName.toLocaleLowerCase('ru-RU').includes(needle)),
    );
  }, [all, engineers, query, side]);

  const selected = pendingEngineer
    ? null
    : (rows.find((chat) => chat.handoff.id === selectedId) ??
      rows.find((chat) => chat.handoff.state !== 'closed') ??
      rows[0] ??
      null);
  const displayRows = rows;

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
    if (text.length === 0 || sending || writesDisabled) return;
    setSending(true);
    setDraft('');
    try {
      if (pendingEngineer && !selected) {
        const chat = await onOpenEngineer(pendingEngineer.id, text);
        setSelectedId(chat.handoff.id);
        setPendingEngineer(null);
        return;
      }
      if (!selected) return;
      await onSendMessage(selected.conversation.id, text);
    } catch (cause: unknown) {
      setOpenError(
        cause instanceof Error ? cause.message : t('figma-dashboard.ChatsView.engineerOpenFailed'),
      );
      setDraft(text);
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

  const handoffOpen =
    selected !== null &&
    selected.handoff.state !== 'closed' &&
    selected.conversation.mode !== 'ai';
  const threadName = selected ? chatName(selected) : (pendingEngineer?.displayName ?? '');
  const threadPortrait = selected
    ? portraitForChat(selected)
    : pendingEngineer
      ? engineerPortrait(pendingEngineer.id, pendingEngineer.displayName)
      : '';
  const threadOpen = selected !== null || pendingEngineer !== null;

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
          style={{ left: 13, top: 174, width: 417, height: 680 + dy }}
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
                  {displayRows.map((chat, index) => {
                    const rowSelected =
                      selected?.handoff.id === chat.handoff.id && pendingEngineer === null;
                    const nextSelected =
                      (pendingEngineer === null &&
                        selected?.handoff.id === displayRows[index + 1]?.handoff.id) ||
                      (index === displayRows.length - 1 &&
                        pendingEngineer?.id === engineersToStart[0]?.id);
                    return (
                      <ChatRow
                        key={chat.conversation.id}
                        chat={chat}
                        top={index * ROW_STEP + 8}
                        last={index === displayRows.length - 1 && engineersToStart.length === 0}
                        selected={rowSelected}
                        hideHairline={rowSelected || nextSelected}
                        workday={workday}
                        onSelect={() => {
                          setPendingEngineer(null);
                          setSelectedId(chat.handoff.id);
                        }}
                      />
                    );
                  })}
                  {engineersToStart.map((engineer, index) => (
                    <EngineerStartRow
                      key={engineer.id}
                      engineer={engineer}
                      top={(displayRows.length + index) * ROW_STEP + 8}
                      last={index === engineersToStart.length - 1}
                      hideHairline={
                        pendingEngineer?.id === engineer.id ||
                        pendingEngineer?.id === engineersToStart[index + 1]?.id
                      }
                      opening={sending && pendingEngineer?.id === engineer.id}
                      writesDisabled={writesDisabled}
                      selected={pendingEngineer?.id === engineer.id}
                      onSelect={() => {
                        setOpenError(null);
                        setSelectedId(null);
                        setPendingEngineer({ id: engineer.id, displayName: engineer.displayName });
                      }}
                    />
                  ))}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {threadOpen ? (
        <>
          <div
            className="absolute flex items-center rounded-[30px] bg-white"
            style={{ left: THREAD_LEFT, top: 67, width: THREAD_WIDTH + dx, height: 66, padding: 6 }}
          >
            <img
              alt=""
              src={threadPortrait}
              className="shrink-0 rounded-full object-cover"
              style={{ width: 54, height: 54 }}
            />
            <span className="min-w-0" style={{ marginLeft: 14 }}>
              <FigmaText className="figma-nowrap block font-murs text-[20px] text-figma-ink">
                {threadName}
              </FigmaText>
              <FigmaText
                className="figma-nowrap block font-semibold text-[18px] text-[#727478]"
                style={{ marginTop: 5 }}
              >
                {selected
                  ? chatStatus(selected)
                  : t('figma-dashboard.ChatsView.startEngineerChat')}
              </FigmaText>
            </span>
            <span className="flex-1" />
            {handoffOpen && selected ? (
              <button
                type="button"
                disabled={writesDisabled}
                onClick={() => void onFinish(selected.conversation.id)}
                className="shrink-0 rounded-full bg-figma-canvas font-semibold text-[16px] text-figma-ink disabled:opacity-50"
                style={{ height: 43, paddingInline: 22, marginRight: 10 }}
              >
                {t('figma-dashboard.ChatsView.14f7a99f9a')}
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
                {(selected?.messages ?? [])
                  .filter((message) => !isHandoffNoise(message.text))
                  .map((message) => (
                    <Bubble
                      key={message.id}
                      message={message}
                      motionOn={!reduceMotion}
                      mascot={
                        message.author === 'assistant'
                          ? selected?.conversation.roleProfile === 'engineer'
                            ? FIGMA_ASSETS.aiKolobokEngineer
                            : FIGMA_ASSETS.aiKolobokClient
                          : null
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
              left: THREAD_LEFT,
              top: 801 + dy,
              width: THREAD_WIDTH + dx,
            }}
          >
            <div
              className="relative overflow-hidden rounded-[200px] bg-figma-ink"
              style={{ height: 79 }}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute flex items-center justify-center rounded-full bg-figma-bee"
                style={{ left: 10, top: 10, width: 60, height: 60 }}
              >
                <FigmaIcon src={FIGMA_ASSETS.brandLine} alt="" width={28} height={28} />
              </span>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={writesDisabled}
                placeholder={t('figma-dashboard.ChatsView.c05ba20c41')}
                aria-label={t('figma-dashboard.ChatsView.04bbba543c')}
                className="absolute bg-transparent font-semibold text-[20px] text-[#ededed] outline-none placeholder:text-[#ededed] disabled:opacity-50"
                style={{ left: 85, right: 83, top: 0, height: 79 }}
              />
              <button
                type="submit"
                disabled={writesDisabled || sending || draft.trim().length === 0}
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
  hideHairline,
  workday,
  onSelect,
}: {
  chat: DispatchChatView;
  top: number;
  last: boolean;
  selected: boolean;
  /** The line under this row is also the line above the next one. A selected row drops both. */
  hideHairline: boolean;
  workday: LiveWorkday | null;
  onSelect: () => void;
}) {
  const activity = handoffMessage(chat);
  const preview = activity?.text ?? originLabel(chat);
  // Messages are stamped on the wall clock; the board is drawn in business time.
  const at = businessAt(activity?.createdAt ?? chat.handoff.createdAt, workday);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className="absolute block w-[390px] text-left"
      style={{ left: 7, top, height: ROW_HEIGHT }}
    >
      {/* Short of the scroller edge so the plate does not sit flush against the card. */}
      {selected ? (
        <span
          aria-hidden
          className="pointer-events-none absolute rounded-[26px] bg-[#e7e9ed]"
          style={{ left: 0, top: -4, width: 392, height: 96 }}
        />
      ) : null}
      <img
        alt=""
        src={portraitForChat(chat)}
        className="absolute rounded-full object-cover"
        style={{ left: 8, top: 10, width: 60, height: 60 }}
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
      {last || hideHairline ? null : (
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
  hideHairline,
  opening,
  writesDisabled,
  selected,
  onSelect,
}: {
  engineer: { readonly id: string; readonly displayName: string; readonly canChat: boolean };
  top: number;
  last: boolean;
  hideHairline: boolean;
  opening: boolean;
  writesDisabled: boolean;
  selected: boolean;
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
      {selected ? (
        <span
          aria-hidden
          className="pointer-events-none absolute rounded-[26px] bg-[#e7e9ed]"
          style={{ left: 0, top: -4, width: 392, height: 96 }}
        />
      ) : null}
      <img
        alt=""
        src={engineerPortrait(engineer.id, engineer.displayName)}
        className="absolute rounded-full object-cover"
        style={{ left: 8, top: 10, width: 60, height: 60 }}
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
      {last || hideHairline ? null : (
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
  mascot,
}: {
  message: AiMessage;
  motionOn: boolean;
  /** Lane mascot, only beside a line the assistant wrote. */
  mascot: string | null;
}) {
  const mine = message.author === 'dispatcher';
  return (
    <>
      <motion.div
        className={`flex w-full items-start ${mine ? 'justify-end' : 'justify-start'}`}
        style={{ gap: 12 }}
        initial={motionOn ? { opacity: 0, y: 12 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={motionOn ? { duration: 0.24, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      >
        {mascot ? (
          <img
            alt=""
            src={mascot}
            className="shrink-0 rounded-full object-cover"
            style={{ width: 48, height: 48 }}
          />
        ) : null}
        <div
          className={mine ? 'bg-figma-ink text-white' : 'bg-white text-figma-ink'}
          style={{ maxWidth: mascot ? BUBBLE_MAX - 60 : BUBBLE_MAX, borderRadius: 20, padding: '18px 24px' }}
        >
          {mine ? (
            <p className="whitespace-pre-wrap font-medium text-[20px]">{message.text}</p>
          ) : (
            /*
             * Only this side. The assistant answers in Markdown — lists, bold, code — and
             * a dispatcher typing into the box below writes plain text, which Markdown
             * would only find stray asterisks in. `AiMarkdown` takes its size from here,
             * so the bubble states the frame's 20/medium itself.
             */
            <span className="block text-[20px]">
              <AiMarkdown text={message.text} />
            </span>
          )}
        </div>
      </motion.div>
    </>
  );
}
