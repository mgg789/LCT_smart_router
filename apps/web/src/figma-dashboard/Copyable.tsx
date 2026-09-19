import { useState, type ReactNode } from 'react';
import { copyableValue, copyText } from './copyText';

const COPIED_MS = 1400;

/**
 * Click-to-copy wrapper for request facts. Disabled when the value is empty.
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
      className={className}
      onClick={async () => {
        const ok = await copyText(value);
        if (!ok) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
      }}
    >
      {children}
      <span aria-live="polite" className="sr-only">
        {copied ? 'Скопировано' : ''}
      </span>
    </button>
  );
}
