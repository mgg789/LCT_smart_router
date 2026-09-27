import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { ExplainTarget } from '../../api/ai';
import { useExplainRun } from '../../hooks/useExplainRun';
import { t } from '../../i18n';
import { AiUnavailablePanel } from './AiUnavailablePanel';

export interface ExplainButtonProps {
  readonly token: string | null;
  readonly target: ExplainTarget;
  /** Defaults to «Объяснить». */
  readonly label?: string;
  /** Icon-only compact form for tight rows (engineer/request rows, table cells). */
  readonly compact?: boolean;
  /** `dark`: for hosting on the dark request/engineer panel (white-on-ink chips). */
  readonly tone?: 'light' | 'dark';
  /** Stretches the trigger to its container -- the standalone request-panel CTA. */
  readonly fullWidth?: boolean;
  readonly className?: string;
  /** Escalates this same target into the full assistant drawer/sheet, if the host page has
   * one -- omitted on hosts that only ever show the quick inline answer. */
  readonly onOpenChat?: (target: ExplainTarget) => void;
}

/**
 * The one explain affordance reused at every "why" site in the product: a small button
 * that, on click, opens an inline panel and starts a one-shot `/ai/explain` run scoped to
 * `target`. Never assembles or replays a stock phrase -- if the API is not reachable this
 * shows the same `AiUnavailablePanel` states as the conversational chat, honestly.
 */
export function ExplainButton({
  token,
  target,
  label = t('components.ai.ExplainButton.26696296dd'),
  compact = false,
  tone = 'light',
  fullWidth = false,
  className,
  onOpenChat,
}: ExplainButtonProps) {
  const [open, setOpen] = useState(false);
  const { state, run, reset } = useExplainRun(token);

  function toggle() {
    if (open) {
      setOpen(false);
      reset();
      return;
    }
    setOpen(true);
    run(target);
  }

  const toneClass =
    tone === 'dark' ? 'border-white/20 bg-white/10 text-white' : 'border-line bg-white text-ink';

  return (
    <div className={className} data-explain-scope={target.scope}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        disabled={token === null}
        title={token === null ? t('components.ai.ExplainButton.23020bb8af') : label}
        className={`${
          compact
            ? 'inline-flex h-7 w-7 items-center justify-center rounded-full border disabled:opacity-40'
            : `inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium disabled:opacity-40 ${
                fullWidth ? 'w-full py-2.5 text-sm' : ''
              }`
        } ${toneClass}`}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0" />
        {compact ? null : label}
      </button>
      {open ? (
        <div className="mt-2 max-w-md rounded-xl border border-line bg-canvas p-3 text-xs leading-5">
          {state.unavailable ? (
            <AiUnavailablePanel reason={state.unavailable} />
          ) : (
            <>
              {state.text.length === 0 && state.loading ? (
                <p className="text-muted">{t('components.ai.ExplainButton.c68c924b18')}</p>
              ) : (
                <p className="whitespace-pre-line text-ink">{state.text}</p>
              )}
              {state.activity ? (
                <p className="mt-1 text-[11px] text-muted">{state.activity}</p>
              ) : null}
              {state.error ? (
                <p role="alert" className="mt-1 text-[11px] text-muted">
                  {state.error}
                </p>
              ) : null}
            </>
          )}
          {onOpenChat ? (
            <button
              type="button"
              onClick={() => {
                onOpenChat(target);
                setOpen(false);
              }}
              className="mt-2 text-[11px] font-semibold underline"
            >
              {t('components.ai.ExplainButton.3ed93ed51b')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
