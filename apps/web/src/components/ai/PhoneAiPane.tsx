import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { isNavixOffline } from '../../domain/mapAvailability';
import { AiMarkdown } from '../../figma-dashboard/AiMarkdown';
import { FIGMA_ASSETS } from '../../figma-dashboard/assets';
import { thoughtLabel } from '../../figma-dashboard/DispatcherAiPane';
import { FigmaIcon } from '../../figma-dashboard/primitives';
import { eu } from '../../figma-engineer/engineerScale';
import {
  type AiOperationView,
  type AssistantChatMessage,
  type AssistantSurface,
  type HandoffStatus,
  useAssistantChat,
} from '../../hooks/useAssistantChat';
import { t } from '../../i18n';
import { AiUnavailablePanel } from './AiUnavailablePanel';
import { ChatBottomSpacer } from './ChatBottomSpacer';
import { ChatMessage } from './ChatMessage';
import { fitComposerField, focusComposer } from './composerField';

/**
 * The assistant screen both phone apps show, drawn to the engineer frames
 * 72:8811 and 72:8913. The device chrome and the browser bar stay out: each app
 * already has its own header.
 *
 * Client and engineer hold the *same* dialogue object the dispatcher writes
 * into: one conversation per account and lane, and a chat opened from the board
 * attaches to that very lane (`ai/runtime/dispatch-chats.service.ts`). So this
 * screen is not only the assistant — it is where a human answer arrives too,
 * and it says which of the two is speaking rather than leaving that to be
 * guessed from the wording.
 */
export function PhoneAiPane({
  token,
  surface,
  greeting,
  quickQuestions,
  avatar,
  placeholder = t('components.ai.PhoneAiPane.a1d1bf51d7'),
  sessionScope,
  onSessionExpired,
  onOperationApplied,
  onOpenObject,
}: {
  token: string | null;
  surface: Extract<AssistantSurface, 'client' | 'engineer'>;
  /** Shown over the empty state, already resolved to this person's name. */
  greeting: string;
  /** First-turn prompts. They belong to the assistant, so a handed-over chat hides them. */
  quickQuestions: readonly string[];
  /** The assistant's face. Each app has its own in the frames, so it is not a constant. */
  avatar: string;
  placeholder?: string;
  /** Scopes persisted history to the signed-in customer where applicable. */
  sessionScope?: string;
  /** Clears an expired surface session after the API rejects it. */
  onSessionExpired?: () => void;
  /** Refreshes surface data after a requested operation has been applied. */
  onOperationApplied?: () => void;
  /** Opens a validated object action from an assistant message. */
  onOpenObject?: (target: { type: 'request' | 'engineer' | 'alert'; id: string }) => void;
}) {
  const offline = isNavixOffline();
  const chat = useAssistantChat({ token: offline ? null : token, surface, sessionScope });
  const [draft, setDraft] = useState('');
  const [thoughtFor, setThoughtFor] = useState<Readonly<Record<string, number>>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const appliedSeen = useRef(new Set<string>());

  useEffect(() => {
    if (chat.unavailable === 'auth') onSessionExpired?.();
  }, [chat.unavailable, onSessionExpired]);

  useEffect(() => {
    for (const operation of chat.operations.values()) {
      if (operation.state === 'applied' && !appliedSeen.current.has(operation.operationId)) {
        appliedSeen.current.add(operation.operationId);
        onOperationApplied?.();
      }
    }
  }, [chat.operations, onOperationApplied]);

  const running = chat.runState === 'running' || chat.sending;
  /*
   * A dispatcher's line is kept whatever it says. The emptiness test below it is
   * about the assistant alone: the model opens a turn with nothing in it while
   * it works, a person does not.
   */
  const spoken = chat.messages.filter((message) => {
    if (message.author === 'user' || message.author === 'dispatcher') return true;
    if (message.author === 'system') return message.text.trim().length > 0;
    if (message.author !== 'assistant') return false;
    return message.text.trim().length > 0 || message.actions.length > 0;
  });
  /** A person holds the dialogue: either yet to answer, or already answering. */
  const handedOver = chat.handoffStatus !== null;
  const empty = !chat.loading && spoken.length === 0;
  const liveAssistant = chat.messages.find(
    (message) => message.author === 'assistant' && message.pending && message.text.length > 0,
  );
  // Nobody is thinking while a person holds the dialogue: there is no run to wait on.
  const thinking = running && !liveAssistant && !empty && !handedOver;
  const canSend =
    token !== null &&
    chat.conversation !== null &&
    !chat.loading &&
    !chat.sending &&
    (chat.runState !== 'running' || spoken.length === 0) &&
    chat.unavailable !== 'auth' &&
    !offline;
  const canFollowUp = canSend && !running && !handedOver;
  const risky = [...chat.operations.values()].find(
    (operation) =>
      operation.guardRisk === true &&
      (operation.state === 'awaiting_confirmation' || operation.state === 'prepared'),
  );

  /** Fills and focuses the composer without submitting a follow-up question. */
  function fillFollowUp(question: string) {
    if (!canFollowUp) return;
    setDraft(question);
    fieldRef.current?.focus();
  }

  useEffect(() => {
    if (running && startedAt.current === null) startedAt.current = Date.now();
  }, [running]);

  useEffect(() => {
    if (running || startedAt.current === null) return;
    const last = [...chat.messages]
      .reverse()
      .find((message) => message.author === 'assistant' && !message.pending);
    const started = startedAt.current;
    startedAt.current = null;
    if (!last) return;
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    setThoughtFor((current) =>
      current[last.id] !== undefined ? current : { ...current, [last.id]: seconds },
    );
  }, [running, chat.messages]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the newest line
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [spoken.length, liveAssistant?.text.length]);

  function submit() {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft('');
    void chat.sendMessage(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: draft changes textarea scrollHeight after React commits the value.
  useEffect(() => {
    if (fieldRef.current) fitComposerField(fieldRef.current);
  }, [draft]);

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 900);
    } catch {
      setCopied(null);
    }
  }

  const composer = (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
      className="w-full"
      style={{ maxWidth: '100%' }}
      title={!canSend && !running && offline ? t('common.offlineContour') : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: The bar is not a second control; it only moves focus into the textarea. */}
      <div
        className="flex items-end bg-figma-ink"
        onMouseDown={(event) => focusComposer(event, fieldRef.current)}
        style={{
          minHeight: eu(112),
          borderRadius: eu(56),
          paddingLeft: eu(10),
          paddingRight: eu(10),
          paddingTop: eu(12),
          paddingBottom: eu(12),
          gap: eu(10),
        }}
      >
        <span
          className="flex shrink-0 items-center justify-center rounded-full bg-figma-bee"
          style={{ width: eu(78), height: eu(78) }}
        >
          <FigmaIcon
            src={FIGMA_ASSETS.iconSparkles}
            alt=""
            width={32}
            height={32}
            style={{ width: eu(28), height: eu(28) }}
          />
        </span>
        <div className="flex min-w-0 flex-1 self-stretch items-center">
          <textarea
            ref={fieldRef}
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={!canSend && !running}
            placeholder={placeholder}
            aria-label={t('components.ai.PhoneAiPane.c520ad9958')}
            className="min-w-0 flex-1 resize-none bg-transparent font-semibold text-[#d9d9d9] outline-none placeholder:text-[#d9d9d9] disabled:opacity-60"
            style={{ fontSize: eu(26), lineHeight: 1.35 }}
          />
        </div>
        {running && !empty ? (
          <button
            type="button"
            onClick={() => void chat.stop()}
            aria-label={t('components.ai.PhoneAiPane.3396400da0')}
            className="flex shrink-0 items-center justify-center rounded-full bg-white/10"
            style={{ width: eu(78), height: eu(78) }}
          >
            <span className="bg-white" style={{ width: eu(16), height: eu(16), borderRadius: 3 }} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend || draft.trim().length === 0}
            aria-label={t('components.ai.PhoneAiPane.ceb68a9287')}
            className="flex shrink-0 items-center justify-center rounded-full bg-white/10 disabled:opacity-40"
            style={{ width: eu(78), height: eu(78) }}
          >
            <FigmaIcon
              src={FIGMA_ASSETS.arrowRightWhite}
              alt=""
              width={28}
              height={28}
              style={{ width: eu(28), height: eu(28) }}
            />
          </button>
        )}
      </div>
    </form>
  );

  return (
    <LayoutGroup>
      <div className="relative flex h-full min-h-0 flex-col">
        <div className="shrink-0 text-sm" role="status">
          {chat.error ? (
            <p role="alert" className="text-figma-cancel">
              {chat.error}
            </p>
          ) : null}
          {chat.unavailable ? (
            <AiUnavailablePanel reason={chat.unavailable} quotaResetAt={chat.quota?.resetAt} />
          ) : null}
        </div>
        {empty && !handedOver ? (
          <div className="flex flex-1 flex-col items-center justify-center" style={{ gap: eu(28) }}>
            <img
              alt=""
              src={avatar}
              width={200}
              height={200}
              className="rounded-full object-cover"
              style={{ width: eu(200), height: eu(200) }}
            />
            <h1
              className="font-murs text-center leading-none tracking-[-0.544px] text-figma-ink"
              style={{ fontSize: eu(32) }}
            >
              {greeting}
            </h1>
            <motion.div
              layoutId="engineer-ai-composer"
              className="w-full"
              style={{ maxWidth: '100%' }}
            >
              {composer}
            </motion.div>
            <div className="flex max-w-full flex-wrap justify-center" style={{ gap: eu(12) }}>
              {quickQuestions.map((question) => (
                <QuickQuestion
                  key={question}
                  question={question}
                  disabled={!canFollowUp}
                  onSelect={fillFollowUp}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
            {/*
             * Outside the scroller, not at the top of it: who holds the dialogue is true
             * of the whole screen, not of the moment the handover happened. Scrolled into
             * the history it stopped answering the question a reader has while reading
             * the newest line.
             */}
            <HandoffBanner status={chat.handoffStatus} />
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-y-auto"
              style={{ paddingBottom: eu(140) }}
            >
              <div className="flex flex-col" style={{ gap: eu(28) }}>
                {spoken.map((message, index) =>
                  message.kind !== 'text' || message.author === 'system' ? (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      operations={chat.operations}
                      disabled={chat.sending}
                      onApplyOperation={(id) => void chat.applyOperation(id)}
                      onCancelOperation={(id) => void chat.cancelOperation(id)}
                      onOpenObject={onOpenObject}
                    />
                  ) : message.author === 'user' ? (
                    <UserBubble
                      key={message.id}
                      text={message.text}
                      copied={copied === message.id}
                      onCopy={() => void copy(message.id, message.text)}
                    />
                  ) : message.author === 'dispatcher' ? (
                    <DispatcherBubble
                      key={message.id}
                      text={message.text}
                      copied={copied === message.id}
                      onCopy={() => void copy(message.id, message.text)}
                    />
                  ) : (
                    <AssistantBubble
                      key={message.id}
                      avatar={avatar}
                      message={message}
                      thoughtSeconds={thoughtFor[message.id] ?? null}
                      copied={copied === message.id}
                      onCopy={() => void copy(message.id, message.text)}
                      onAgain={() => {
                        const previous = [...spoken.slice(0, index)]
                          .reverse()
                          .find((item) => item.author === 'user');
                        if (previous && canSend) void chat.sendMessage(previous.text);
                      }}
                      onFollowUp={canFollowUp ? fillFollowUp : undefined}
                    />
                  ),
                )}
                {thinking ? <ThinkingRow avatar={avatar} /> : null}
                <ChatBottomSpacer />
              </div>
            </div>
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-figma-canvas from-50% to-transparent"
              style={{ paddingBottom: eu(24), paddingTop: eu(48) }}
            >
              <motion.div
                layoutId="engineer-ai-composer"
                className="pointer-events-auto w-full"
                style={{ maxWidth: '100%' }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                {composer}
              </motion.div>
            </div>
          </>
        )}
        {risky ? (
          <GuardModal
            operation={risky}
            onAllow={() => void chat.applyOperation(risky.operationId)}
            onReject={() => void chat.cancelOperation(risky.operationId)}
          />
        ) : null}
      </div>
    </LayoutGroup>
  );
}

/** Adds a safe suggested question to the draft; selection never sends it. */
function QuickQuestion({
  question,
  disabled,
  onSelect,
}: {
  question: string;
  disabled: boolean;
  onSelect: (question: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect(question)}
      className="rounded-full bg-white px-4 py-3 text-center font-semibold text-figma-ink transition-colors hover:bg-figma-bee focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-figma-ink disabled:cursor-not-allowed disabled:opacity-50"
      style={{ fontSize: eu(18) }}
    >
      {question}
    </button>
  );
}

function UserBubble({
  text,
  copied,
  onCopy,
}: {
  text: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col items-end" style={{ gap: eu(8) }}>
      <div
        className="bg-white"
        style={{ maxWidth: eu(557), borderRadius: eu(20), padding: eu(24) }}
      >
        <p
          className="whitespace-pre-wrap font-medium leading-normal text-figma-ink"
          style={{ fontSize: eu(24) }}
        >
          {text}
        </p>
      </div>
      <IconButton
        label={
          copied
            ? t('components.ai.PhoneAiPane.d2d08c715e')
            : t('components.ai.PhoneAiPane.1ecddf40bf')
        }
        onClick={onCopy}
      >
        <FigmaIcon
          src={FIGMA_ASSETS.aiCopy}
          alt=""
          width={28}
          height={28}
          style={{ width: eu(28), height: eu(28) }}
        />
      </IconButton>
    </div>
  );
}

function GuardModal({
  operation,
  onAllow,
  onReject,
}: {
  operation: AiOperationView;
  onAllow: () => void;
  onReject: () => void;
}) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40"
      style={{ padding: eu(32) }}
    >
      <div
        className="w-full bg-white"
        style={{ borderRadius: eu(24), padding: eu(28), maxWidth: eu(560) }}
      >
        {operation.preview.length > 0 ? (
          <dl style={{ display: 'flex', flexDirection: 'column', gap: eu(8) }}>
            {operation.preview.map((row) => (
              <div
                key={row.label}
                className="flex justify-between"
                style={{ gap: eu(16), fontSize: eu(22) }}
              >
                <dt className="text-figma-muted">{row.label}</dt>
                <dd className="text-right font-medium text-figma-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="font-medium text-[#d92d20]" style={{ marginTop: eu(18), fontSize: eu(24) }}>
          {t('components.ai.PhoneAiPane.a363333a47')}
        </p>
        <div className="flex" style={{ marginTop: eu(22), gap: eu(12) }}>
          <button
            type="button"
            onClick={onReject}
            className="flex-1 rounded-full bg-figma-ink font-semibold text-white"
            style={{ height: eu(72), fontSize: eu(22) }}
          >
            {t('components.ai.PhoneAiPane.899c5d6de8')}
          </button>
          <button
            type="button"
            onClick={onAllow}
            className="flex-1 rounded-full bg-[#d92d20] font-semibold text-white"
            style={{ height: eu(72), fontSize: eu(22) }}
          >
            {t('components.ai.PhoneAiPane.241ed4211a')}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({
  avatar,
  message,
  thoughtSeconds,
  copied,
  onCopy,
  onAgain,
  onFollowUp,
}: {
  avatar: string;
  message: AssistantChatMessage;
  thoughtSeconds: number | null;
  copied: boolean;
  onCopy: () => void;
  onAgain: () => void;
  onFollowUp?: (question: string) => void;
}) {
  return (
    <div className="flex flex-col items-start">
      <div className="flex items-center" style={{ gap: eu(16) }}>
        <img
          alt=""
          src={avatar}
          width={74}
          height={74}
          className="shrink-0 rounded-full object-cover"
          style={{ width: eu(74), height: eu(74) }}
        />
        {thoughtSeconds !== null ? (
          <div
            className="bg-white"
            style={{ borderRadius: eu(20), padding: `${eu(16)} ${eu(24)}` }}
          >
            <p className="font-medium leading-none text-figma-ink" style={{ fontSize: eu(20) }}>
              {thoughtLabel(thoughtSeconds)}
            </p>
          </div>
        ) : null}
      </div>
      <div
        className="font-medium text-figma-ink"
        style={{ marginTop: eu(16), fontSize: eu(24), maxWidth: eu(590) }}
      >
        <AiMarkdown text={message.text} onFollowUp={onFollowUp} />
      </div>
      {!message.pending ? (
        <div className="flex items-center" style={{ marginTop: eu(12), gap: eu(18) }}>
          <IconButton
            label={
              copied
                ? t('components.ai.PhoneAiPane.d2d08c715e')
                : t('components.ai.PhoneAiPane.1ecddf40bf')
            }
            onClick={onCopy}
          >
            <FigmaIcon
              src={FIGMA_ASSETS.aiCopy}
              alt=""
              width={28}
              height={28}
              style={{ width: eu(28), height: eu(28) }}
            />
          </IconButton>
          <IconButton label={t('components.ai.PhoneAiPane.1a4a5b2dce')} onClick={onAgain}>
            <RefreshCw style={{ width: eu(22), height: eu(22) }} aria-hidden />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Says the dialogue has left the assistant, and whether the answer is still on
 * its way. Without it a reply signed «Диспетчер» reads as the model playing a
 * part, and the silence before it reads as the assistant having stalled.
 */
export function HandoffBanner({ status }: { status: HandoffStatus }) {
  if (status === null) return null;
  return (
    <div
      className="flex shrink-0 items-center bg-white"
      style={{
        marginBottom: eu(28),
        gap: eu(14),
        borderRadius: eu(20),
        padding: `${eu(18)} ${eu(24)}`,
      }}
    >
      <span
        className={status === 'answered' ? 'bg-figma-bee' : 'bg-figma-muted'}
        style={{ width: eu(14), height: eu(14), borderRadius: eu(999) }}
        aria-hidden
      />
      <p className="font-medium text-figma-ink" style={{ fontSize: eu(20) }}>
        {status === 'answered'
          ? t('components.ai.PhoneAiPane.0c63c73a35')
          : t('components.ai.PhoneAiPane.7521c4f3fc')}
      </p>
    </div>
  );
}

function DispatcherBubble({
  text,
  copied,
  onCopy,
}: {
  text: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col items-start" style={{ gap: eu(8) }}>
      <p
        className="font-semibold uppercase tracking-[0.08em] text-figma-muted"
        style={{ fontSize: eu(16) }}
      >
        {t('components.ai.PhoneAiPane.d75c355491')}
      </p>
      <div
        className="bg-figma-bee"
        style={{ maxWidth: eu(557), borderRadius: eu(20), padding: eu(24) }}
      >
        <p
          className="whitespace-pre-wrap font-medium leading-normal text-figma-ink"
          style={{ fontSize: eu(24) }}
        >
          {text}
        </p>
      </div>
      <IconButton
        label={
          copied
            ? t('components.ai.PhoneAiPane.d2d08c715e')
            : t('components.ai.PhoneAiPane.1ecddf40bf')
        }
        onClick={onCopy}
      >
        <FigmaIcon
          src={FIGMA_ASSETS.aiCopy}
          alt=""
          width={28}
          height={28}
          style={{ width: eu(28), height: eu(28) }}
        />
      </IconButton>
    </div>
  );
}

function ThinkingRow({ avatar }: { avatar: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="flex items-center" style={{ gap: eu(16) }} aria-live="polite">
      <motion.img
        alt=""
        src={avatar}
        width={74}
        height={74}
        className="shrink-0 rounded-full object-cover"
        style={{ width: eu(74), height: eu(74) }}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.28 }}
      />
      <div
        className="flex items-center justify-center bg-white"
        style={{ width: eu(182), height: eu(44), borderRadius: eu(20), gap: eu(6) }}
      >
        <span className="ai-think-dot" />
        <span className="ai-think-dot" />
        <span className="ai-think-dot" />
        <span className="sr-only">{t('components.ai.PhoneAiPane.6bb1ef689f')}</span>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="ai-icon-btn text-figma-ink"
    >
      {children}
    </button>
  );
}
