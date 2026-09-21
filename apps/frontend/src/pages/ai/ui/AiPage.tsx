import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { Check, Copy, Pencil, RotateCw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AssistantMessage, Rating, UserMessage } from '@/features/ai/ask-assistant';
import { AskBar, useConversation } from '@/features/ai/ask-assistant';
import { cn, EASE_OUT, fadeSoft, useMotionOn } from '@/shared/lib';
import { AiAvatar } from '@/shared/ui';

/** Width of the conversation column, from the drawing (444 → 1480). */
const COLUMN = 'w-[1036px] max-w-full';

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
    <button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex size-10 items-center justify-center rounded-[10px] text-ink transition-[background-color,transform] duration-150 hover:bg-muted active:scale-95',
        active && 'bg-[#d8d8d8] hover:bg-[#d8d8d8]',
      )}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden size={22} strokeWidth={1.8} />
    </button>
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

function UserBubble({ message, onEdit }: { message: UserMessage; onEdit: () => void }) {
  return (
    <div className="flex flex-col items-end">
      <p className="max-w-[80%] rounded-[24px] bg-surface px-6 py-[13px] text-[18px] text-ink leading-[22px]">
        {message.text}
      </p>
      <div className="mt-[18px] flex gap-1">
        <CopyAction text={message.text} />
        <IconAction icon={Pencil} label="Изменить вопрос" onClick={onEdit} />
      </div>
    </div>
  );
}

function AssistantAnswer({
  message,
  onRetry,
  onRate,
}: {
  message: AssistantMessage;
  onRetry: () => void;
  onRate: (rating: Rating) => void;
}) {
  const reply = message.reply;
  // The drawing's pill says how long the model thought. With no model behind
  // the screen there is no such number, so the pill says what is true instead.
  const pill = reply
    ? reply.connected && reply.thoughtSec !== null
      ? `Думал ${reply.thoughtSec} секунд`
      : 'Ассистент не подключён'
    : 'Думает…';

  return (
    <div className="flex gap-5">
      <AiAvatar size={60} />
      <div className="min-w-0 flex-1 pt-2">
        <span className="inline-flex h-[42px] items-center rounded-full bg-surface px-6 text-[16px] text-ink">
          {pill}
        </span>
        {reply ? (
          <motion.div animate={{ opacity: 1 }} initial={{ opacity: 0 }} transition={fadeSoft}>
            <p className="mt-6 whitespace-pre-line text-[20px] text-ink leading-6">{reply.text}</p>
            <div className="mt-5 flex gap-1">
              <CopyAction text={reply.text} />
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
            </div>
          </motion.div>
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
 */
export function AiPage() {
  const { messages, ask, retry, rate } = useConversation();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const motionOn = useMotionOn();
  const started = messages.length > 0;

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
      transition={{ duration: 0.5, ease: EASE_OUT }}
    >
      <AskBar inputRef={inputRef} onChange={setDraft} onSubmit={send} value={draft} />
    </motion.div>
  );

  return (
    <LayoutGroup>
      <div className="relative flex h-full min-h-0 flex-col items-center">
        <AnimatePresence initial={false} mode="popLayout">
          {!started ? (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-1 flex-col items-center justify-center pb-[120px]"
              exit={motionOn ? { opacity: 0, y: -24 } : undefined}
              initial={motionOn ? { opacity: 0, y: 12 } : false}
              key="greeting"
              transition={fadeSoft}
            >
              <AiAvatar size={120} />
              {/* The drawing greets the dispatcher by name; the API gives no name, only an address. */}
              <h1 className="mt-12 font-display text-[34px] text-ink">С чего начнём сегодня?</h1>
              <div className="mt-10">{bar}</div>
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
                  <AnimatePresence initial={false}>
                    {messages.map((message) => (
                      <motion.li
                        animate={{ opacity: 1, y: 0 }}
                        initial={motionOn ? { opacity: 0, y: 16 } : false}
                        key={message.id}
                        transition={fadeSoft}
                      >
                        {message.role === 'user' ? (
                          <UserBubble
                            message={message}
                            onEdit={() => {
                              setDraft(message.text);
                              inputRef.current?.focus();
                            }}
                          />
                        ) : (
                          <AssistantAnswer
                            message={message}
                            onRate={(rating) => rate(message.id, rating)}
                            onRetry={() => void retry(message.id)}
                          />
                        )}
                      </motion.li>
                    ))}
                  </AnimatePresence>
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
              <div className="absolute bottom-[40px]">{bar}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}
