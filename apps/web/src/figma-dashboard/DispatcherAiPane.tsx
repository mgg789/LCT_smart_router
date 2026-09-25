import { motion, useReducedMotion } from 'framer-motion';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { AiActionButton } from '../api/ai';
import { AiOperationCard } from '../components/ai/AiOperationCard';
import {
  type AiOperationView,
  type AiUnavailableReason,
  type AssistantChatMessage,
  useAssistantChat,
} from '../hooks/useAssistantChat';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon } from './primitives';

/** Where an assistant button may send the dispatcher. The id is one the server already vetted. */
export interface AiOpenTarget {
  readonly type: 'request' | 'engineer' | 'alert';
  readonly id: string;
}

interface PaneProps {
  readonly token: string | null;
  readonly onOpenObject?: (target: AiOpenTarget) => void;
}

/**
 * Dispatcher AI tab drawn to the NAVIX frame: an empty greeting, then a transcript
 * with the same assistant stream the chat hook already speaks to the gateway.
 */
export function DashboardAi({ token, onOpenObject }: PaneProps) {
  const chat = useAssistantChat({ token, surface: 'dispatcher' });
  const [draft, setDraft] = useState('');
  const [thoughtFor, setThoughtFor] = useState<Readonly<Record<string, number>>>({});
  const [rating, setRating] = useState<Readonly<Record<string, 'up' | 'down'>>>({});
  const startedAt = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const running = chat.runState === 'running' || chat.sending;
  const liveAssistant = chat.messages.find(
    (message) => message.author === 'assistant' && message.pending && message.text.length > 0,
  );
  const thinking = running && !liveAssistant;

  useEffect(() => {
    if (running && startedAt.current === null) startedAt.current = Date.now();
  }, [running]);

  useEffect(() => {
    if (!liveAssistant || startedAt.current === null) return;
    const seconds = Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
    startedAt.current = null;
    const id = liveAssistant.id;
    setThoughtFor((current) =>
      current[id] !== undefined ? current : { ...current, [id]: seconds },
    );
  }, [liveAssistant]);

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
  }, [chat.messages.length, liveAssistant?.text.length]);

  const spoken = chat.messages.filter(
    (message) => message.author === 'user' || message.author === 'assistant',
  );
  const empty = !chat.loading && spoken.length === 0 && !thinking;
  const canSend =
    token !== null &&
    chat.conversation !== null &&
    !chat.loading &&
    !chat.sending &&
    chat.runState !== 'running' &&
    chat.unavailable !== 'auth';

  function submit() {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft('');
    void chat.sendMessage(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section className="absolute inset-0 flex flex-col bg-figma-canvas">
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-[28px] px-[48px]">
          <img
            alt=""
            src={FIGMA_ASSETS.aiKolobok}
            width={120}
            height={120}
            className="size-[120px] rounded-full bg-[#f8f8f8] object-cover"
          />
          <h1 className="font-murs text-center text-[32px] leading-none tracking-[-0.544px] text-figma-ink">
            С чего начнем сегодня?
          </h1>
          <Composer
            draft={draft}
            canSend={canSend}
            running={false}
            notice={noticeOf(chat.error, chat.unavailable)}
            onDraft={setDraft}
            onKeyDown={onKeyDown}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            onStop={() => void chat.stop()}
          />
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto px-[48px] pb-[160px] pt-[88px]"
          >
            <div className="mx-auto flex w-full max-w-[1036px] flex-col gap-[28px]">
              {chat.loading && spoken.length === 0 ? (
                <p className="text-center text-[16px] text-figma-muted">Загружаем диалог…</p>
              ) : null}
              {spoken.map((message) =>
                message.author === 'user' ? (
                  <UserBubble key={message.id} text={message.text} />
                ) : (
                  <AssistantBubble
                    key={message.id}
                    message={message}
                    thoughtSeconds={thoughtFor[message.id] ?? null}
                    rating={rating[message.id] ?? null}
                    operations={chat.operations}
                    disabled={chat.sending}
                    onRate={(next) => setRating((current) => ({ ...current, [message.id]: next }))}
                    onApply={(operationId) => void chat.applyOperation(operationId)}
                    onCancel={(operationId) => void chat.cancelOperation(operationId)}
                    onOpenObject={onOpenObject}
                  />
                ),
              )}
              {thinking ? <ThinkingRow /> : null}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-figma-canvas from-55% to-transparent px-[48px] pb-[36px] pt-[72px]">
            <Composer
              draft={draft}
              canSend={canSend}
              running={chat.runState === 'running'}
              notice={noticeOf(chat.error, chat.unavailable)}
              onDraft={setDraft}
              onKeyDown={onKeyDown}
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
              onStop={() => void chat.stop()}
            />
          </div>
        </>
      )}
    </section>
  );
}

function Composer({
  draft,
  canSend,
  running,
  notice,
  onDraft,
  onKeyDown,
  onSubmit,
  onStop,
}: {
  draft: string;
  canSend: boolean;
  running: boolean;
  notice: string | null;
  onDraft: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
}) {
  return (
    <form onSubmit={onSubmit} className="pointer-events-auto w-full max-w-[813px]">
      {notice ? (
        <p role="alert" className="mb-[10px] text-center text-[14px] text-figma-muted">
          {notice}
        </p>
      ) : null}
      <div className="flex h-[79px] items-center gap-[12px] rounded-[200px] bg-figma-ink pl-[10px] pr-[10px]">
        <span className="flex size-[60px] shrink-0 items-center justify-center rounded-full bg-figma-bee">
          <FigmaIcon src={FIGMA_ASSETS.iconSparkles} alt="" width={26} height={26} />
        </span>
        <input
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={!canSend && !running}
          placeholder="Спроси меня о чем нибудь..."
          aria-label="Сообщение ассистенту"
          className="h-full min-w-0 flex-1 bg-transparent font-semibold text-[18px] text-white outline-none placeholder:text-[#ededed] disabled:opacity-60"
        />
        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Остановить"
            className="flex size-[63px] shrink-0 items-center justify-center rounded-full bg-white/10"
          >
            <span className="size-[14px] rounded-[3px] bg-white" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canSend || draft.trim().length === 0}
            aria-label="Отправить"
            className="flex size-[63px] shrink-0 items-center justify-center rounded-full bg-white/10 disabled:opacity-40"
          >
            <FigmaIcon src={FIGMA_ASSETS.arrowRightWhite} alt="" width={24} height={24} />
          </button>
        )}
      </div>
    </form>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-[8px]">
      <div className="max-w-[720px] rounded-full bg-white px-[24px] py-[18px]">
        <p className="text-[18px] font-medium leading-[1.25] text-figma-ink">{text}</p>
      </div>
      <CopyButton text={text} />
    </div>
  );
}

function AssistantBubble({
  message,
  thoughtSeconds,
  rating,
  operations,
  disabled,
  onRate,
  onApply,
  onCancel,
  onOpenObject,
}: {
  message: AssistantChatMessage;
  thoughtSeconds: number | null;
  rating: 'up' | 'down' | null;
  operations: ReadonlyMap<string, AiOperationView>;
  disabled: boolean;
  onRate: (next: 'up' | 'down') => void;
  onApply: (operationId: string) => void;
  onCancel: (operationId: string) => void;
  onOpenObject?: (target: AiOpenTarget) => void;
}) {
  const operationId = message.actions.find((action) => action.operationId)?.operationId;
  return (
    <div className="flex flex-col items-start">
      <div className="flex items-center gap-[20px]">
        <img
          alt=""
          src={FIGMA_ASSETS.aiKolobok}
          width={60}
          height={60}
          className="size-[60px] shrink-0 rounded-full object-cover"
        />
        {thoughtSeconds !== null ? (
          <div className="rounded-full bg-white px-[24px] py-[16px]">
            <p className="text-[16px] font-medium leading-none text-figma-ink">
              {thoughtLabel(thoughtSeconds)}
            </p>
          </div>
        ) : null}
      </div>
      <div className="mt-[16px] max-w-[956px] pl-[80px] text-[20px] font-medium tracking-[-0.272px] text-figma-ink">
        {message.pending ? (
          <StreamingWords text={message.text} />
        ) : (
          <AnswerBody text={message.text} />
        )}
        {message.kind === 'text_confirmation' ? null : (
          <ActionRow
            actions={message.actions}
            disabled={disabled}
            onApply={onApply}
            onCancel={onCancel}
            onOpenObject={onOpenObject}
          />
        )}
        {message.kind === 'text_confirmation' && operationId ? (
          <AiOperationCard
            operationId={operationId}
            operation={operations.get(operationId)}
            disabled={disabled}
            onApply={() => onApply(operationId)}
            onCancel={() => onCancel(operationId)}
          />
        ) : null}
      </div>
      {!message.pending ? (
        <div className="mt-[16px] flex items-center gap-[12px] pl-[80px]">
          <CopyButton text={message.text} />
          <RateButton
            src={FIGMA_ASSETS.aiThumbUp}
            label="Полезно"
            pressed={rating === 'up'}
            onClick={() => onRate('up')}
          />
          <RateButton
            src={FIGMA_ASSETS.aiThumbDown}
            label="Не полезно"
            pressed={rating === 'down'}
            onClick={() => onRate('down')}
          />
        </div>
      ) : null}
    </div>
  );
}

function ThinkingRow() {
  const reduceMotion = useReducedMotion();
  return (
    <div className="flex items-center gap-[20px]" aria-live="polite">
      <motion.img
        alt=""
        src={FIGMA_ASSETS.aiKolobok}
        width={60}
        height={60}
        className="size-[60px] shrink-0 rounded-full object-cover"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
      />
      <div className="flex h-[44px] w-[182px] items-center justify-center gap-[6px] rounded-full bg-white">
        <span className="ai-think-dot" />
        <span className="ai-think-dot" />
        <span className="ai-think-dot" />
        <span className="sr-only">Ассистент думает</span>
      </div>
    </div>
  );
}

function StreamingWords({ text }: { text: string }) {
  const reduceMotion = useReducedMotion();
  const parts = text.split(/(\s+)/);
  let cursor = 0;
  return (
    <p className="leading-[normal]" aria-live="polite">
      {parts.map((part) => {
        const start = cursor;
        cursor += part.length;
        return (
          <motion.span
            key={start}
            initial={reduceMotion ? false : { opacity: 0, y: 6, filter: 'blur(4px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {part}
          </motion.span>
        );
      })}
    </p>
  );
}

function AnswerBody({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  let cursor = 0;
  return (
    <div className="flex flex-col gap-[16px] leading-[normal]">
      {blocks.map((block) => {
        const blockStart = cursor;
        cursor += block.length + 2;
        let lineCursor = blockStart;
        return (
          <p key={blockStart}>
            {block.split('\n').map((line) => {
              const lineStart = lineCursor;
              lineCursor += line.length + 1;
              const bullet = /^\s*[•\-–]\s+/.test(line);
              return (
                <span key={lineStart} className={bullet ? 'block text-figma-muted' : 'block'}>
                  {line.length === 0 ? '\u00a0' : line}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

function ActionRow({
  actions,
  disabled,
  onApply,
  onCancel,
  onOpenObject,
}: {
  actions: readonly AiActionButton[];
  disabled: boolean;
  onApply: (operationId: string) => void;
  onCancel: (operationId: string) => void;
  onOpenObject?: (target: AiOpenTarget) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-[16px] flex flex-wrap gap-[8px]">
      {actions.map((action) => (
        <button
          key={`${action.kind}-${action.operationId ?? action.label}`}
          type="button"
          disabled={disabled}
          onClick={() => {
            if (action.kind === 'confirm_operation' && action.operationId)
              onApply(action.operationId);
            else if (action.kind === 'cancel_operation' && action.operationId)
              onCancel(action.operationId);
            else if (action.kind === 'open_object' && action.target) onOpenObject?.(action.target);
          }}
          className="rounded-full bg-white px-[18px] py-[10px] text-[16px] font-semibold text-figma-ink disabled:opacity-50"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      aria-label="Копировать"
      onClick={() => void navigator.clipboard.writeText(text)}
      className="flex size-[24px] items-center justify-center"
    >
      <FigmaIcon src={FIGMA_ASSETS.aiCopy} alt="" width={24} height={24} />
    </button>
  );
}

function RateButton({
  src,
  label,
  pressed,
  onClick,
}: {
  src: string;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex size-[40px] items-center justify-center rounded-[10px] ${pressed ? 'bg-figma-track' : ''}`}
    >
      <FigmaIcon src={src} alt="" width={24} height={24} />
    </button>
  );
}

function noticeOf(error: string | null, unavailable: AiUnavailableReason | null): string | null {
  if (unavailable === 'quota') return 'Лимит сообщений на сегодня исчерпан.';
  if (unavailable === 'auth') return 'Нужна сессия диспетчера.';
  if (unavailable === 'provider') return error ?? 'Ассистент сейчас недоступен.';
  if (unavailable === 'stopped') return 'Ответ остановлен.';
  return error;
}

/** «Думал 1 секунду / 2 секунды / 5 секунд». */
export function thoughtLabel(seconds: number): string {
  const n = Math.max(1, Math.round(seconds));
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'секунду'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'секунды'
        : 'секунд';
  return `Думал ${n} ${word}`;
}
