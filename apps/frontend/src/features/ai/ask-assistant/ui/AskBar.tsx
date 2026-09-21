import { ArrowRight, Sparkles } from 'lucide-react';
import type { FormEvent, RefObject } from 'react';
import { cn } from '@/shared/lib';

export interface AskBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  className?: string;
}

/**
 * The prompt bar (Figma 66:1677): an 813×79 ink pill, the accent circle with
 * sparkles on the left, the send circle on the right. Enter sends; an empty
 * question does not.
 */
export function AskBar({ value, onChange, onSubmit, inputRef, className }: AskBarProps) {
  const empty = value.trim() === '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!empty) onSubmit(value);
  };

  return (
    <form
      className={cn(
        'flex h-[79px] w-[813px] max-w-full items-center rounded-full bg-ink pr-2 pl-[10px] shadow-[0_18px_40px_rgba(39,41,48,0.14)]',
        className,
      )}
      onSubmit={submit}
    >
      <span className="flex size-[60px] shrink-0 items-center justify-center rounded-full bg-accent text-ink">
        <Sparkles aria-hidden size={26} strokeWidth={1.8} />
      </span>
      <label className="sr-only" htmlFor="ai-question">
        Вопрос ассистенту
      </label>
      <input
        autoComplete="off"
        className="ml-[15px] min-w-0 flex-1 bg-transparent font-semibold text-[#ededed] text-[18px] outline-none placeholder:text-[#ededed]"
        id="ai-question"
        onChange={(event) => onChange(event.target.value)}
        placeholder="Спроси меня о чём-нибудь…"
        ref={inputRef}
        value={value}
      />
      <button
        aria-label="Отправить"
        className={cn(
          'flex size-[63px] shrink-0 items-center justify-center rounded-full text-white',
          'bg-gradient-to-b from-white/20 to-white/[0.05] shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] ring-1 ring-white/20',
          'transition-[transform,opacity] duration-150 enabled:hover:scale-[1.06] enabled:active:scale-[0.95] disabled:opacity-45',
        )}
        disabled={empty}
        type="submit"
      >
        <ArrowRight aria-hidden size={28} />
      </button>
    </form>
  );
}
