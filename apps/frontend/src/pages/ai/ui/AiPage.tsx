import type { Variants } from 'framer-motion';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { Check, Copy, Pencil, RotateCw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/app/routes/paths';
import type { AiActionButton } from '@/entities/conversation';
import type {
  AssistantMessage,
  OperationCard,
  Rating,
  UserMessage,
} from '@/features/ai/ask-assistant';
import { AskBar, resumeConversation, useConversation } from '@/features/ai/ask-assistant';
import { cn, EASE_OUT, fadeSoft, springQuick, useMotionOn } from '@/shared/lib';
import { AiAvatar, Markdown } from '@/shared/ui';

/**
 * Where «открыть объект» goes. The target is what the dashboard should select —
 * a type and an id the server vetted — never a URL from the model (§9.5), so the
 * route is chosen here and only the id travels.
 */
const TARGET_ROUTE: Record<'request' | 'engineer' | 'alert', (id: string) => string> = {
  request: (id) => `${ROUTES.plan}?request=${encodeURIComponent(id)}`,
  engineer: () => ROUTES.engineers,
  alert: () => ROUTES.alerts,
};

/** Width of the conversation column, from the drawing (444 → 1480). */
const COLUMN = 'w-[1036px] max-w-full';

/**
 * The drawing centres this screen on the window, not on the area beside the
 * rail: half of what the rail and the left gutter take, less the right gutter,
 * (149 + 31 − 34) / 2.
 */
const SCREEN_CENTRE_SHIFT = 73;

/**
 * A word of an answer arriving: from slightly below, out of a blur. Its delay
 * comes in through `custom` — a transition set on the element itself would be
 * overridden by the variant's own.
 */
const WORD: Variants = {
  hidden: { opacity: 0, y: 6, filter: 'blur(4px)' },
  shown: (delay: number) => ({
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.3, ease: EASE_OUT, delay },
  }),
};

/** Past this many words the rest arrive together, so a long answer is not a slideshow. */
const WORD_LIMIT = 60;

/** The buttons under a message come in one after another, once the text is there. */
const ACTIONS: Variants = {
  hidden: {},
  shown: (delay: number) => ({ transition: { delayChildren: delay, staggerChildren: 0.05 } }),
};
const ACTION: Variants = {
  hidden: { opacity: 0, y: 6, scale: 0.9 },
  shown: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.22, ease: EASE_OUT } },
};

/** One of the small icon buttons under a message; `active` is the drawn grey tile. */
function IconAction({
  icon: Icon,
  label,
  onClick,
  active = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <motion.button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex size-10 items-center justify-center rounded-[10px] text-ink transition-colors duration-150 hover:bg-muted',
        active && 'bg-[#d8d8d8] hover:bg-[#d8d8d8]',
      )}
      onClick={onClick}
      title={label}
      type="button"
      variants={ACTION}
      whileTap={{ scale: 0.9 }}
    >
      {/* A thumb that has just been set gives a small bounce. */}
      <motion.span
        animate={active ? { scale: [1, 1.25, 1] } : { scale: 1 }}
        className="flex"
        transition={{ duration: 0.3, ease: EASE_OUT }}
      >
        <Icon aria-hidden size={22} strokeWidth={1.8} />
      </motion.span>
    </motion.button>
  );
}

/** Copies text and says so for a moment by turning its icon into a tick. */
function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <IconAction
      icon={copied ? Check : Copy}
      label={copied ? 'Скопировано' : 'Копировать'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
    />
  );
}

/** The three dots of an answer on its way. */
function TypingDots() {
  return (
    <span aria-hidden className="ml-2 inline-flex gap-1">
      {[0, 1, 2].map((dot) => (
        <motion.span
          animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
          className="size-[5px] rounded-full bg-ink"
          key={dot}
          transition={{ duration: 0.9, repeat: Number.POSITIVE_INFINITY, delay: dot * 0.15 }}
        />
      ))}
    </span>
  );
}

function UserBubble({
  message,
  onEdit,
  motionOn,
}: {
  message: UserMessage;
  onEdit: () => void;
  motionOn: boolean;
}) {
  return (
    <div className="flex flex-col items-end">
      {/* The question leaves the bar and settles on the right, growing from its corner. */}
      <motion.p
        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
        className="max-w-[80%] origin-bottom-right rounded-[24px] bg-surface px-6 py-[13px] text-[18px] text-ink leading-[22px]"
        initial={motionOn ? { opacity: 0, x: 24, y: 24, scale: 0.92 } : false}
        transition={springQuick}
      >
        {message.text}
      </motion.p>
      <motion.div
        animate="shown"
        className="mt-[18px] flex gap-1"
        custom={0.2}
        initial={motionOn ? 'hidden' : false}
        variants={ACTIONS}
      >
        <CopyAction text={message.text} />
        <IconAction icon={Pencil} label="Изменить вопрос" onClick={onEdit} />
      </motion.div>
    </div>
  );
}

/**
 * How each operation state reads to the dispatcher.
 *
 * `cancelled_before_apply` and `outcome_unknown` are deliberately not synonyms
 * (docs/frontend-api.md §9.6): the first is a write that never ran, the second a
 * write that may or may not have. Calling the second one «отменено» — or
 * «выполнено» — would state a guess as a fact, so it says what is actually known
 * and points at the object to check.
 */
const OPERATION_STATE: Record<string, string> = {
  prepared: 'Подготовлено',
  awaiting_confirmation: 'Ждёт подтверждения',
  running: 'Выполняется',
  applied: 'Выполнено',
  rejected: 'Отклонено',
  cancelled_before_apply: 'Отменено до применения — записи не было',
  outcome_unknown: 'Исход неизвестен — проверьте объект напрямую',
};

/** A card the server prepared: its rows, as rendered from validated arguments. */
function OperationCardView({ card }: { card: OperationCard }) {
  return (
    <section
      aria-label={`Операция ${card.action}`}
      className="mt-5 rounded-[20px] border border-ink/12 bg-surface px-6 py-5"
    >
      <p className="font-semibold text-[16px] text-ink-soft">{card.action}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[16px]">
        {card.preview.map((row) => (
          <Fragment key={`${row.label}:${row.value}`}>
            <dt className="text-ink-soft">{row.label}</dt>
            <dd className="text-ink">{row.value}</dd>
          </Fragment>
        ))}
      </dl>
      <p
        className={cn(
          'mt-3 text-[16px]',
          card.state === 'applied' ? 'text-success' : 'text-ink-soft',
          card.state === 'outcome_unknown' && 'text-danger',
        )}
      >
        {OPERATION_STATE[card.state] ?? card.state}
      </p>
      {card.error ? <p className="mt-1 text-[16px] text-danger">{card.error}</p> : null}
    </section>
  );
}

function AssistantAnswer({
  message,
  onRetry,
  onRate,
  onAct,
  motionOn,
}: {
  message: AssistantMessage;
  onRetry: () => void;
  onRate: (rating: Rating) => void;
  onAct: (button: AiActionButton) => void;
  motionOn: boolean;
}) {
  const text = message.text;
  // The drawing's pill says how long the model thought; now there is a model, so
  // it says the seconds the run actually took, measured from its own events.
  const pill = message.streaming
    ? 'Думает'
    : message.thoughtSec !== null
      ? `Думал ${message.thoughtSec} секунд`
      : 'Ответ получен';
  const words = text ? text.split(/(\s+)/) : [];
  // While the text streams in, each word is already late; delaying it again
  // would let the answer trail behind the tokens that produced it.
  const wordDelay = (index: number) =>
    message.streaming ? 0 : Math.min(index / 2, WORD_LIMIT) * 0.018;
  const textTime = wordDelay(words.length) + 0.3;

  return (
    <div className="flex gap-5">
      <motion.div
        animate={{ opacity: 1, scale: 1, rotate: 0 }}
        className="self-start"
        initial={motionOn ? { opacity: 0, scale: 0.5, rotate: -20 } : false}
        transition={{ type: 'spring', stiffness: 380, damping: 18 }}
      >
        <AiAvatar size={60} />
      </motion.div>
      <div className="min-w-0 flex-1 pt-2">
        <motion.span
          animate={{ opacity: 1, x: 0 }}
          className="inline-flex h-[42px] items-center rounded-full bg-surface px-6 text-[16px] text-ink"
          initial={motionOn ? { opacity: 0, x: -12 } : false}
          layout={motionOn}
          transition={{ ...fadeSoft, delay: motionOn ? 0.1 : 0 }}
        >
          <AnimatePresence initial={false} mode="wait">
            <motion.span
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={motionOn ? { opacity: 0 } : false}
              key={pill}
              transition={{ duration: 0.18 }}
            >
              {pill}
            </motion.span>
          </AnimatePresence>
          {message.streaming ? <TypingDots /> : null}
        </motion.span>

        <AnimatePresence initial={false} mode="wait">
          {text !== null ? (
            // «Спросить ещё раз» clears the text first, so the answer plays in afresh.
            <motion.div
              exit={motionOn ? { opacity: 0, transition: { duration: 0.15 } } : undefined}
              key={message.id}
            >
              {/*
               * The answer is Markdown, so it is drawn as Markdown — bold,
               * italics, code and lists. Still word by word: the reveal counts
               * across the whole answer, not per block, or every paragraph
               * would start at once.
               */}
              <motion.div
                animate="shown"
                className="mt-6 text-[20px] text-ink leading-6"
                initial={motionOn ? 'hidden' : false}
              >
                <Markdown text={text} wordDelay={wordDelay} wordVariants={WORD} />
              </motion.div>

              {message.cards.map((card) => (
                <OperationCardView card={card} key={card.operationId} />
              ))}

              {message.actions.length > 0 ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {message.actions.map((button) => (
                    <button
                      className={cn(
                        'rounded-full px-5 py-2 font-semibold text-[16px] transition-transform duration-150 active:scale-[0.97]',
                        button.kind === 'confirm_operation'
                          ? 'bg-ink text-white'
                          : 'border border-ink/20 text-ink hover:bg-muted',
                      )}
                      key={`${button.kind}:${button.operationId ?? button.target?.id ?? button.label}`}
                      onClick={() => onAct(button)}
                      type="button"
                    >
                      {button.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <motion.div
                animate="shown"
                className="mt-5 flex gap-1"
                custom={motionOn ? textTime : 0}
                initial={motionOn ? 'hidden' : false}
                variants={ACTIONS}
              >
                <CopyAction text={text} />
                <IconAction
                  active={message.rating === 'up'}
                  icon={ThumbsUp}
                  label="Хороший ответ"
                  onClick={() => onRate(message.rating === 'up' ? null : 'up')}
                />
                <IconAction
                  active={message.rating === 'down'}
                  icon={ThumbsDown}
                  label="Плохой ответ"
                  onClick={() => onRate(message.rating === 'down' ? null : 'down')}
                />
                <IconAction icon={RotateCw} label="Спросить ещё раз" onClick={onRetry} />
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Shown outside the answer block: a run can fail before any text arrives. */}
        {message.failure ? <p className="mt-4 text-[16px] text-danger">{message.failure}</p> : null}

        {message.notes.length > 0 ? (
          <details className="mt-4 text-[16px] text-ink-soft">
            <summary className="cursor-pointer">
              Что ассистент смотрел ({message.notes.length})
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {message.notes.map((note, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the journal is append-only; a line's place in it is its identity.
                <li key={index}>{note}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/**
 * «AI» (Figma 64:1395 → 66:1775): a greeting and the prompt bar, then — once
 * something is asked — the conversation, with the bar settled at the bottom.
 *
 * The screen is built to the drawing, but there is no assistant behind it: the
 * System Layer has no AI contract. Every question gets the same plain answer
 * saying so; nothing is sent anywhere and nothing pretends to have thought. The
 * thumbs and «повторить» work on the screen, and the day's real explanations
 * are one click away where the answer points to them.
 *
 * Motion carries the conversation: the question grows out of the corner by the
 * bar, the assistant's face pops in, its answer surfaces word by word and the
 * buttons under it follow. None of it delays an answer — there is no pretend
 * thinking time — it only shapes how the text arrives.
 */
export function AiPage() {
  const { messages, ask, retry, rate, act, stop, runId, mode, quota } = useConversation();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const endRef = useRef<HTMLDivElement>(null);
  const motionOn = useMotionOn();
  const started = messages.length > 0;

  // The dialogue lives on the server, so opening the screen picks up whatever it
  // already holds — a reload mid-answer is a resume, not a lost reply (§9.2).
  useEffect(() => {
    void resumeConversation().catch(() => undefined);
  }, []);

  // The newest message is the one to read; keep it in view as the thread grows.
  useEffect(() => {
    if (messages.length > 0) endRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const send = (text: string) => {
    setDraft('');
    void ask(text);
    // The first question moves the bar, which remounts its field; give focus back.
    window.setTimeout(() => inputRef.current?.focus(), 60);
  };

  const bar = (
    // One bar, two places: it glides from under the greeting to the bottom of
    // the thread when the first question is asked.
    <motion.div
      layout={motionOn}
      layoutId="ai-ask-bar"
      transition={{ duration: 0.55, ease: EASE_OUT }}
    >
      <AskBar inputRef={inputRef} onChange={setDraft} onSubmit={send} value={draft} />
    </motion.div>
  );

  const rise = (delay: number) => ({
    initial: motionOn ? { opacity: 0, y: 16 } : false,
    animate: { opacity: 1, y: 0 },
    transition: { ...fadeSoft, delay: motionOn ? delay : 0 },
  });

  return (
    <LayoutGroup>
      <div
        className="relative flex h-full min-h-0 flex-col items-center"
        style={{ left: -SCREEN_CENTRE_SHIFT }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {!started ? (
            <motion.div
              className="flex flex-1 flex-col items-center justify-center pb-[120px]"
              exit={motionOn ? { opacity: 0, y: -24, transition: fadeSoft } : undefined}
              key="greeting"
            >
              <motion.div
                animate={{ opacity: 1, scale: 1 }}
                initial={motionOn ? { opacity: 0, scale: 0.6 } : false}
                transition={{ type: 'spring', stiffness: 260, damping: 18 }}
              >
                {/* The face breathes while it waits for the first question. */}
                <motion.div
                  animate={motionOn ? { y: [0, -6, 0], rotate: [0, -3, 0, 3, 0] } : undefined}
                  transition={{ duration: 5, repeat: Number.POSITIVE_INFINITY, ease: 'easeInOut' }}
                >
                  <AiAvatar size={120} />
                </motion.div>
              </motion.div>
              {/* The drawing greets the dispatcher by name; the API gives no name, only an address. */}
              <motion.h1 className="mt-12 font-display text-[34px] text-ink" {...rise(0.12)}>
                С чего начнём сегодня?
              </motion.h1>
              <motion.div className="mt-10" {...rise(0.22)}>
                {bar}
              </motion.div>
            </motion.div>
          ) : (
            <motion.div
              animate={{ opacity: 1 }}
              className="flex min-h-0 w-full flex-1 flex-col items-center"
              initial={motionOn ? { opacity: 0 } : false}
              key="thread"
              transition={fadeSoft}
            >
              <div
                className="min-h-0 w-full flex-1 overflow-y-auto"
                // Messages pass under the bar and fade instead of being cut.
                style={{
                  maskImage:
                    'linear-gradient(to bottom, transparent 0, #000 48px, #000 calc(100% - 150px), transparent calc(100% - 40px))',
                }}
              >
                <ol className={cn(COLUMN, 'mx-auto flex flex-col gap-10 pt-[100px]')}>
                  {messages.map((message) => (
                    <li key={message.id}>
                      {message.role === 'user' ? (
                        <UserBubble
                          message={message}
                          motionOn={motionOn}
                          onEdit={() => {
                            setDraft(message.text);
                            inputRef.current?.focus();
                          }}
                        />
                      ) : (
                        <AssistantAnswer
                          message={message}
                          motionOn={motionOn}
                          onAct={(button) => {
                            if (button.kind === 'open_object' && button.target) {
                              navigate(TARGET_ROUTE[button.target.type](button.target.id));
                              return;
                            }
                            void act(message.id, button);
                          }}
                          onRate={(rating) => rate(message.id, rating)}
                          onRetry={() => void retry(message.id)}
                        />
                      )}
                    </li>
                  ))}
                  {/* Room under the last answer, so scrolling to the end lifts it clear of the bar. */}
                  <div className="h-[150px] shrink-0" ref={endRef} />
                </ol>
              </div>

              {/* The soft light the drawing puts under the bar. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[220px]"
                style={{
                  background:
                    'radial-gradient(60% 100% at 50% 100%, rgba(255,255,255,0.95), rgba(255,255,255,0))',
                }}
              />
              <div className="absolute bottom-[40px] flex flex-col items-center gap-3">
                {bar}
                <div className="flex h-6 items-center gap-4 text-[16px] text-ink-soft">
                  {runId ? (
                    <button
                      className="rounded-full border border-ink/20 px-4 py-1 text-ink transition-colors duration-150 hover:bg-muted"
                      onClick={() => void stop()}
                      type="button"
                    >
                      Остановить
                    </button>
                  ) : null}
                  {mode === 'dispatcher' ? <span>Диалог ведёт диспетчер</span> : null}
                  {quota ? (
                    <span>Осталось сообщений сегодня: {quota.remainingMessages}</span>
                  ) : null}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}
