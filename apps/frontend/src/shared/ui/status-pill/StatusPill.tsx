import { cn } from '../../lib/cn';

export type StatusTone = 'running' | 'neutral' | 'done' | 'attention';

export interface StatusPillProps {
  tone: StatusTone;
  children: React.ReactNode;
}

const TONE_CLASS: Record<StatusTone, string> = {
  running: 'bg-success-soft text-success-ink',
  neutral: 'bg-muted text-ink/55',
  done: 'bg-ink text-white',
  attention: 'bg-accent text-ink',
};

const DOT_CLASS: Record<StatusTone, string> = {
  running: 'bg-success-ink',
  neutral: 'bg-ink/35',
  done: 'bg-white',
  attention: 'bg-ink',
};

/** Status chip of the requests table: a dot and a word, nothing more. */
export function StatusPill({ tone, children }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 py-1.5 text-[16px]',
        TONE_CLASS[tone],
      )}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[tone])} />
      {children}
    </span>
  );
}
