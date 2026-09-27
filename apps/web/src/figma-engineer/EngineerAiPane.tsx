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
import { AiUnavailablePanel } from '../components/ai/AiUnavailablePanel';
import { ChatBottomSpacer } from '../components/ai/ChatBottomSpacer';
import { ChatMessage } from '../components/ai/ChatMessage';
import { fitComposerField, focusComposer } from '../components/ai/composerField';
import { HandoffBanner } from '../components/ai/HandoffBanner';
import { isNavixOffline } from '../domain/mapAvailability';
import { AiMarkdown } from '../figma-dashboard/AiMarkdown';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import { thoughtLabel } from '../figma-dashboard/DispatcherAiPane';
import { FigmaIcon } from '../figma-dashboard/primitives';
import {
  type AiOperationView,
  type AssistantChatMessage,
  useAssistantChat,
} from '../hooks/useAssistantChat';
import { t } from '../i18n';
import { eu } from './engineerScale';

/** First-turn prompts for route context, problem triage and retaining checks already done. */
export const ENGINEER_QUICK_QUESTIONS = [
  t('figma-engineer.EngineerAiPane.176369bc5c'),
  t('figma-engineer.EngineerAiPane.7b0bae4276'),
  t('figma-engineer.EngineerAiPane.4917c6fbc2'),
] as const;

/**
 * First name for the empty greeting. A missing profile stays unnamed: the frame's
 * "Илья" is a sample, not this engineer's name.
 */
export function engineerGreeting(displayName: string | null | undefined): string {
  const first = displayName?.trim().split(/\s+/)[0] ?? '';
  if (first.length === 0 || first === t('figma-engineer.EngineerAiPane.88d71676fa'))
    return t('figma-engineer.EngineerAiPane.8e356a4b41');
  return t('figma-engineer.EngineerAiPane.b33fce20e1', { value0: first });
}

/**
 * Engineer assistant drawn to the phone frames 72:8811 and 72:8913.
 * The device chrome and the browser bar stay out: the app already has its own header.
 */
export function EngineerAiPane({
  token,
  displayName,
  surface = 'engineer',
  avatarSrc = '/figma/mascot-engineer-blue.png',
  quickQuestions = ENGINEER_QUICK_QUESTIONS,
  onOperationApplied,
  onOpenObject,
  sessionScope,
  onSessionExpired,
}: {
  token: string | null;
  displayName: string | null;
  surface?: 'engineer' | 'client';
  sessionScope?: string;
  onSessionExpired?: () => void;
  avatarSrc?: string;
  quickQuestions?: readonly string[];
  onOperationApplied?: () => void;
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

  useEffect(() => {
    if (chat.unavailable === 'auth') onSessionExpired?.();
  }, [chat.unavailable, onSessionExpired]);
  const appliedSeen = useRef(new Set<string>());
  useEffect(() => {
    for (const operation of chat.operations.values()) {
      if (operation.state === 'applied' && !appliedSeen.current.has(operation.operationId)) {
        appliedSeen.current.add(operation.operationId);
        onOperationApplied?.();
      }
    }
  }, [chat.operations, onOperationApplied]);

  const running = chat.runState === 'running' || chat.sending;
  const spoken = chat.messages.filter((message) => {
    if (message.author === 'user') return true;
    if (message.author !== 'assistant') return message.text.trim().length > 0;
    return message.text.trim().length > 0 || message.actions.length > 0;
  });
  const empty = !chat.loading && spoken.length === 0;
  const liveAssistant = chat.messages.find(
    (message) => message.author === 'assistant' && message.pending && message.text.length > 0,
  );
  const thinking = running && !liveAssistant && !empty;
  const canSend =
    token !== null &&
    chat.conversation !== null &&
    !chat.loading &&
    !chat.sending &&
    (chat.runState !== 'running' || spoken.length === 0) &&
    chat.unavailable !== 'auth' &&
    !offline;
  const canFollowUp = canSend && !running;
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
      title={!canSend && !running && offline ? t('common.offlineContour') : undefined}
      className="w-full"
      style={{ maxWidth: '100%' }}
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
            placeholder={t('figma-engineer.EngineerAiPane.a1d1bf51d7')}
            aria-label={t('figma-engineer.EngineerAiPane.c520ad9958')}
            className="min-w-0 flex-1 resize-none bg-transparent font-semibold text-[#d9d9d9] outline-none placeholder:text-[#d9d9d9] disabled:opacity-60"
            style={{ fontSize: eu(26), lineHeight: 1.35 }}
          />
        </div>
        {running && !empty ? (
          <button
            type="button"
            onClick={() => void chat.stop()}
            aria-label={t('figma-engineer.EngineerAiPane.3396400da0')}
            className="flex shrink-0 items-center justify-center rounded-full bg-white/10"
            style={{ width: eu(78), height: eu(78) }}
          >
            <span className="bg-white" style={{ width: eu(16), height: eu(16), borderRadius: 3 }} />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend || draft.trim().length === 0}
            aria-label={t('figma-engineer.EngineerAiPane.ceb68a9287')}
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
          <HandoffBanner status={chat.handoffStatus} />
          {chat.error ? (
            <p role="alert" className="text-figma-cancel">
              {chat.error}
            </p>
          ) : null}
          {chat.unavailable ? (
            <AiUnavailablePanel reason={chat.unavailable} quotaResetAt={chat.quota?.resetAt} />
          ) : null}
        </div>

        {empty ? (
          <div className="flex flex-1 flex-col items-center justify-center" style={{ gap: eu(28) }}>
            <img
              alt=""
              src={avatarSrc}
              width={200}
              height={200}
              className="rounded-full object-cover"
              style={{ width: eu(200), height: eu(200) }}
            />
            <h1
              className="font-murs text-center leading-none tracking-[-0.544px] text-figma-ink"
              style={{ fontSize: eu(32) }}
            >
              {engineerGreeting(displayName)}
            </h1>
            <motion.div
              layoutId={`${surface}-ai-composer`}
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
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-y-auto"
              style={{ paddingBottom: eu(140) }}
            >
              <div className="flex flex-col" style={{ gap: eu(28) }}>
                {spoken.map((message, index) =>
                  message.author === 'user' ? (
                    <UserBubble
                      key={message.id}
                      text={message.text}
                      copied={copied === message.id}
                      onCopy={() => void copy(message.id, message.text)}
                    />
                  ) : message.kind !== 'text' || message.author !== 'assistant' ? (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      operations={chat.operations}
                      disabled={chat.sending}
                      onApplyOperation={(id) => void chat.applyOperation(id)}
                      onCancelOperation={(id) => void chat.cancelOperation(id)}
                      onOpenObject={onOpenObject}
                    />
                  ) : (
                    <AssistantBubble
                      avatarSrc={avatarSrc}
                      key={message.id}
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
                {thinking ? <ThinkingRow avatarSrc={avatarSrc} /> : null}
                <ChatBottomSpacer />
              </div>
            </div>
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-figma-canvas from-50% to-transparent"
              style={{ paddingBottom: eu(24), paddingTop: eu(48) }}
            >
              <motion.div
                layoutId={`${surface}-ai-composer`}
                className="pointer-events-auto w-full"
                style={{ maxWidth: '100%' }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                {composer}
              </motion.div>
            </div>
          </>
        )}
        {risky && surface === 'engineer' ? (
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
            ? t('figma-engineer.EngineerAiPane.d2d08c715e')
            : t('figma-engineer.EngineerAiPane.1ecddf40bf')
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
          {t('figma-engineer.EngineerAiPane.a363333a47')}
        </p>
        <div className="flex" style={{ marginTop: eu(22), gap: eu(12) }}>
          <button
            type="button"
            onClick={onReject}
            className="flex-1 rounded-full bg-figma-ink font-semibold text-white"
            style={{ height: eu(72), fontSize: eu(22) }}
          >
            {t('figma-engineer.EngineerAiPane.899c5d6de8')}
          </button>
          <button
            type="button"
            onClick={onAllow}
            className="flex-1 rounded-full bg-[#d92d20] font-semibold text-white"
            style={{ height: eu(72), fontSize: eu(22) }}
          >
            {t('figma-engineer.EngineerAiPane.241ed4211a')}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({
  avatarSrc,
  message,
  thoughtSeconds,
  copied,
  onCopy,
  onAgain,
  onFollowUp,
}: {
  avatarSrc: string;
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
          src={avatarSrc}
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
                ? t('figma-engineer.EngineerAiPane.d2d08c715e')
                : t('figma-engineer.EngineerAiPane.1ecddf40bf')
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
          <IconButton label={t('figma-engineer.EngineerAiPane.1a4a5b2dce')} onClick={onAgain}>
            <RefreshCw style={{ width: eu(22), height: eu(22) }} aria-hidden />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}

function ThinkingRow({ avatarSrc }: { avatarSrc: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="flex items-center" style={{ gap: eu(16) }} aria-live="polite">
      <motion.img
        alt=""
        src={avatarSrc}
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
        <span className="sr-only">{t('figma-engineer.EngineerAiPane.6bb1ef689f')}</span>
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
