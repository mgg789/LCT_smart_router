import { Copy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { copyableValue, copyText } from './copyText';

const COPIED_MS = 1400;

/**
 * Click-to-copy wrapper for request facts. Disabled when the value is empty.
 * On success the row flashes and a copy icon blinks in so the click is obvious.
 */
export function Copyable({
  value,
  className,
  children,
  label,
}: {
  value: string | null | undefined;
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = copyableValue(value);
  return (
    <button
      type="button"
      disabled={!text}
      aria-label={label ?? (text ? `Скопировать ${text}` : undefined)}
      title={copied ? 'Скопировано' : text ? 'Скопировать' : undefined}
      className={`group inline-flex items-center gap-[10px] transition-transform duration-150 active:scale-[0.99] ${
        copied ? 'copy-row-flash' : ''
      } ${className ?? ''}`}
      onClick={async () => {
        const ok = await copyText(value);
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
      }}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {text ? (
        <Copy
          size={18}
          strokeWidth={2.25}
          aria-hidden
          className={`shrink-0 text-white ${copied ? 'copy-icon-blink' : 'opacity-0 group-hover:opacity-50'}`}
        />
      ) : null}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Скопировано' : ''}
      </span>
    </button>
  );
}
