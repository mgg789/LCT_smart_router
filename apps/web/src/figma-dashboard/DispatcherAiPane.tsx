import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { Trash2 } from 'lucide-react';
import {
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { AiActionButton } from '../api/ai';
import { AiOperationCard } from '../components/ai/AiOperationCard';
import { fitComposerField, focusComposer } from '../components/ai/composerField';
import {
  type AiOperationView,
  type AiUnavailableReason,
  type AssistantChatMessage,
  useAssistantChat,
} from '../hooks/useAssistantChat';
import { AiMarkdown } from './AiMarkdown';
import { FIGMA_ASSETS } from './assets';
import { FigmaIcon } from './primitives';

/** Date row sits at 84px and is 40px tall. The transcript starts just under it. */
const CONTENT_TOP = 148;
const RATINGS_KEY = 'lct.ai.ratings';

/** First-turn questions about assignment reasons and already calculated plan alternatives. */
export const DISPATCHER_QUICK_QUESTIONS = [
  'Что влияет на назначение заявок?',
  'Сравни рассчитанные варианты плана',
] as const;

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
  const [rating, setRating] = useState<Readonly<Record<string, 'up' | 'down'>>>(readRatings);
  const startedAt = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

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

  const spoken = chat.messages.filter((message) => {
    if (message.author === 'user') return true;
    if (message.author !== 'assistant') return false;
    return message.text.trim().length > 0 || message.actions.length > 0;
  });
  const empty = !chat.loading && spoken.length === 0;
  const canSend =
    token !== null &&
    chat.conversation !== null &&
    !chat.loading &&
    !chat.sending &&
    (chat.runState !== 'running' || spoken.length === 0) &&
    chat.unavailable !== 'auth';
  const canFollowUp = canSend && !running;

  /** Fills and focuses the composer without submitting a follow-up question. */
  function fillFollowUp(question: string) {
    if (!canFollowUp) return;
    setDraft(question);
    composerRef.current?.focus();
  }

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

  const mode = chat.conversation?.assistMode === 'fix' ? 'fix' : 'help';
  const risky = [...chat.operations.values()].find(
    (operation) =>
      operation.guardRisk === true &&
      (operation.state === 'awaiting_confirmation' || operation.state === 'prepared'),
  );

  const composer = (
    <Composer
      draft={draft}
      canSend={canSend}
      running={running && !empty}
      notice={noticeOf(chat.error, chat.unavailable)}
      status={activityLine(chat.activity, running && !empty)}
      onDraft={setDraft}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onStop={() => void chat.stop()}
      fieldRef={composerRef}
    />
  );

  return (
    <LayoutGroup>
      <section
        className="absolute inset-0 flex flex-col bg-figma-canvas"
        style={{ paddingTop: CONTENT_TOP }}
      >
        <LaneBar
          mode={mode}
          disabled={chat.conversation === null || chat.loading}
          onMode={(next) => void chat.setAssistMode(next)}
          onClear={() => void chat.clearConversation()}
        />
        {risky ? (
          <GuardModal
            operation={risky}
            onAllow={() => void chat.applyOperation(risky.operationId)}
            onReject={() => void chat.cancelOperation(risky.operationId)}
          />
        ) : null}
        {empty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-[28px] px-[48px] pb-[48px]">
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
            <motion.div layoutId="dispatcher-ai-composer" className="w-full max-w-[813px]">
              {composer}
            </motion.div>
            <div className="flex max-w-[813px] flex-wrap justify-center gap-[10px]">
              {DISPATCHER_QUICK_QUESTIONS.map((question) => (
                <FollowUpSuggestion
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
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-[48px] pb-[160px]">
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
                      onRate={(next) =>
                        setRating((current) => {
                          const saved = { ...current, [message.id]: next };
                          writeRatings(saved);
                          return saved;
                        })
                      }
                      onApply={(operationId) => void chat.applyOperation(operationId)}
                      onCancel={(operationId) => void chat.cancelOperation(operationId)}
                      onOpenObject={onOpenObject}
                      onFollowUp={canFollowUp ? fillFollowUp : undefined}
                    />
                  ),
                )}
                {thinking ? <ThinkingRow /> : null}
              </div>
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-figma-canvas from-55% to-transparent px-[48px] pb-[36px] pt-[72px]">
              <motion.div
                layoutId="dispatcher-ai-composer"
                className="pointer-events-auto w-full max-w-[813px]"
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                {composer}
              </motion.div>
            </div>
          </>
        )}
      </section>
    </LayoutGroup>
  );
}

function waitingOnGuard(operation: AiOperationView | undefined): boolean {
  return (
    operation?.guardRisk === true &&
    (operation.state === 'awaiting_confirmation' || operation.state === 'prepared')
  );
}

/** Consultant / agent switch and the trash that archives the dialogue. Centered on the artboard, beside the clock's MCP slot. */
function LaneBar({
  mode,
  disabled,
  onMode,
  onClear,
}: {
  mode: 'help' | 'fix';
  disabled: boolean;
  onMode: (mode: 'help' | 'fix') => void;
  onClear: () => void;
}) {
  return (
    <div className="absolute left-1/2 top-[84px] z-30 flex -translate-x-1/2 items-center gap-[12px]">
      <div className="flex h-[40px] items-center rounded-full bg-white p-[3px] shadow-[0_4px_14px_rgba(15,16,20,0.08)]">
        <LaneButton
          label="Консультант"
          pressed={mode === 'help'}
          disabled={disabled}
          onClick={() => onMode('help')}
        />
        <LaneButton
          label="Агент"
          pressed={mode === 'fix'}
          disabled={disabled}
          onClick={() => onMode('fix')}
        />
      </div>
      <button
        type="button"
        aria-label="Очистить чат"
        disabled={disabled}
        onClick={onClear}
        className="flex size-[40px] items-center justify-center rounded-full bg-white text-figma-ink shadow-[0_4px_14px_rgba(15,16,20,0.08)] disabled:opacity-40"
      >
        <Trash2 className="size-[18px]" aria-hidden />
      </button>
    </div>
  );
}

function LaneButton({
  label,
  pressed,
  disabled,
  onClick,
}: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-[34px] rounded-full px-[16px] text-[14px] font-semibold disabled:opacity-40 ${
        pressed ? 'text-white' : 'text-figma-muted'
      }`}
    >
      {pressed ? (
        <motion.span
          layoutId="dispatcher-lane-pill"
          className="absolute inset-0 rounded-full bg-figma-ink"
          transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        />
      ) : null}
      <span className="relative z-10">{label}</span>
    </button>
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
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 px-[48px]">
      <div className="w-full max-w-[560px] rounded-[24px] bg-white p-[28px] shadow-[0_16px_40px_rgba(15,16,20,0.18)]">
        <p className="font-murs text-[28px] leading-none tracking-[-0.4px] text-figma-ink">
          {operation.action}
        </p>
        {operation.preview.length > 0 ? (
          <dl className="mt-[16px] space-y-[8px]">
            {operation.preview.map((row) => (
              <div key={row.label} className="flex justify-between gap-[16px] text-[16px]">
                <dt className="text-figma-muted">{row.label}</dt>
                <dd className="text-right font-medium text-figma-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="mt-[18px] text-[16px] font-medium text-[#d92d20]">
          Гуард пометил это действие как рисковое!
        </p>
        <div className="mt-[22px] flex gap-[12px]">
          <button
            type="button"
            onClick={onReject}
            className="h-[52px] flex-1 rounded-full bg-figma-ink text-[16px] font-semibold text-white"
          >
            Отклонить
          </button>
          <button
            type="button"
            onClick={onAllow}
            className="h-[52px] flex-1 rounded-full bg-[#d92d20] text-[16px] font-semibold text-white"
          >
            Разрешить
          </button>
        </div>
      </div>
    </div>
  );
}

function Composer({
  draft,
  canSend,
  running,
  notice,
  status,
  onDraft,
  onKeyDown,
  onSubmit,
  onStop,
  fieldRef,
}: {
  draft: string;
  canSend: boolean;
  running: boolean;
  notice: string | null;
  status: string | null;
  onDraft: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft changes textarea scrollHeight after React commits the value.
  useEffect(() => {
    if (fieldRef.current) fitComposerField(fieldRef.current);
  }, [draft, fieldRef]);
  return (
    <form onSubmit={onSubmit} className="pointer-events-auto w-full max-w-[813px]">
      {notice || status ? (
        <p
          role={notice ? 'alert' : 'status'}
          className="mb-[10px] text-center text-[14px] text-figma-muted"
        >
          {notice ?? status}
        </p>
      ) : null}
      {/* Click on the black bar focuses the field. The textarea remains the keyboard target. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: The bar is not a second control; it only moves focus into the textarea. */}
      <div
        className="flex min-h-[79px] items-end gap-[12px] rounded-[40px] bg-figma-ink px-[10px] py-[8px]"
        onMouseDown={(event) => focusComposer(event, fieldRef.current)}
      >
        <span className="flex size-[63px] shrink-0 items-center justify-center rounded-full bg-figma-bee">
          <FigmaIcon src={FIGMA_ASSETS.iconSparkles} alt="" width={26} height={26} />
        </span>
        <div className="flex min-w-0 flex-1 self-stretch items-center">
          <textarea
            ref={fieldRef}
            value={draft}
            rows={1}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={!canSend && !running}
            placeholder="Спроси меня о чем нибудь..."
            aria-label="Сообщение ассистенту"
            className="min-w-0 flex-1 resize-none bg-transparent font-semibold text-[18px] leading-[1.35] text-white outline-none placeholder:text-[#ededed] disabled:opacity-60"
          />
        </div>
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

/** Adds a safe suggested question to the composer; selection never sends it. */
function FollowUpSuggestion({
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
      className="rounded-full bg-white px-[18px] py-[10px] text-[14px] font-medium text-figma-ink transition-colors hover:bg-figma-bee focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-figma-ink disabled:cursor-not-allowed disabled:opacity-50"
    >
      {question}
    </button>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end gap-[8px]">
      <div className="max-w-[720px] rounded-full bg-white px-[24px] py-[18px]">
        <p className="whitespace-pre-wrap text-[18px] font-medium leading-[1.25] text-figma-ink">
          {text}
        </p>
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
  onFollowUp,
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
  onFollowUp?: (question: string) => void;
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
        <AiMarkdown text={message.text} onFollowUp={onFollowUp} />
        {message.kind === 'text_confirmation' ? null : (
          <ActionRow
            actions={message.actions}
            disabled={disabled}
            onApply={onApply}
            onCancel={onCancel}
            onOpenObject={onOpenObject}
          />
        )}
        {message.kind === 'text_confirmation' &&
        operationId &&
        !waitingOnGuard(operations.get(operationId)) ? (
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
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Скопировано' : 'Копировать'}
      data-pop={copied ? 'true' : 'false'}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 900);
        });
      }}
      className="ai-icon-btn flex size-[40px] items-center justify-center rounded-[10px]"
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
      className="ai-icon-btn ai-rate-btn flex size-[40px] items-center justify-center rounded-[10px]"
    >
      <FigmaIcon src={src} alt="" width={24} height={24} />
    </button>
  );
}

const TOOL_LINES: Readonly<Record<string, string>> = {
  get_situation: 'AI смотрит смену',
  get_day_plan: 'AI смотрит план',
  list_engineers: 'AI смотрит инженеров',
  list_requests: 'AI смотрит заявки',
  get_request: 'AI смотрит заявку',
  get_request_history: 'AI читает историю заявки',
  list_alerts: 'AI читает алерты',
  get_shift_status: 'AI смотрит смену',
  get_policies: 'AI смотрит политики',
  compare_policies: 'AI сравнивает политики',
  get_router_settings: 'AI смотрит настройки',
  get_snapshot_diagnostics: 'AI проверяет снимок',
  evaluate_manual_order: 'AI выбирает стратегию',
  search_documentation: 'AI читает документацию',
  prepare_move_window: 'AI переносит окно',
  prepare_reschedule_request: 'AI переносит заявку',
  prepare_update_request: 'AI меняет заявку',
  prepare_cancel_request: 'AI отменяет заявку',
  prepare_create_request: 'AI создаёт заявку',
  prepare_select_policy: 'AI выбирает стратегию',
  prepare_set_engineer_availability: 'AI меняет доступность',
  prepare_set_engineer_workday: 'AI меняет смену',
  prepare_engineer_technical_break: 'AI ставит перерыв',
  prepare_resolve_alert: 'AI закрывает алерт',
  prepare_mark_alert_seen: 'AI отмечает алерт',
  prepare_close_shift: 'AI закрывает смену',
};

/** What to print above the composer while a turn is in flight. */
function activityLine(activity: string | null, running: boolean): string | null {
  if (!running) return null;
  if (activity === 'Проверка безопасности') return activity;
  if (activity && TOOL_LINES[activity]) return TOOL_LINES[activity];
  return 'AI думает';
}

function noticeOf(error: string | null, unavailable: AiUnavailableReason | null): string | null {
  if (unavailable === 'quota') return 'Лимит сообщений на сегодня исчерпан.';
  if (unavailable === 'auth') return 'Нужна сессия диспетчера.';
  if (unavailable === 'provider') return error ?? 'Ассистент сейчас недоступен.';
  if (unavailable === 'stopped') return 'Ответ остановлен.';
  return error;
}

function readRatings(): Readonly<Record<string, 'up' | 'down'>> {
  try {
    const raw = window.localStorage.getItem(RATINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ratings: Record<string, 'up' | 'down'> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (value === 'up' || value === 'down') ratings[id] = value;
    }
    return ratings;
  } catch {
    return {};
  }
}

function writeRatings(ratings: Readonly<Record<string, 'up' | 'down'>>): void {
  try {
    window.localStorage.setItem(RATINGS_KEY, JSON.stringify(ratings));
  } catch {
    // A blocked store must not stop the thumb from painting.
  }
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
