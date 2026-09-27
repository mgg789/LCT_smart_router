import { Copy } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { t } from '../i18n';
import { copyableValue, copyText } from './copyText';

const COPIED_MS = 700;

/**
 * Click-to-copy wrapper for request facts. Disabled when the value is empty.
 * On success the icon flashes once — bright and large, then eases back to its
 * hover state.
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
  const timer = useRef<number | null>(null);
  const text = copyableValue(value);
  return (
    <button
      type="button"
      disabled={!text}
      aria-label={
        label ?? (text ? t('figma-dashboard.Copyable.ca74b6e952', { value0: text }) : undefined)
      }
      title={
        copied
          ? t('figma-dashboard.Copyable.d2d08c715e')
          : text
            ? t('figma-dashboard.Copyable.f02956c165')
            : undefined
      }
      className={`group inline-flex items-center gap-[10px] transition-transform duration-150 active:scale-[0.99] ${
        copied ? 'copy-row-flash' : ''
      } ${className ?? ''}`}
      onClick={async () => {
        const ok = await copyText(value);
        if (!ok) return;
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      }}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {text ? (
        <Copy
          size={18}
          strokeWidth={2.25}
          aria-hidden
          className={`shrink-0 text-white transition-[opacity,transform] duration-300 ease-out ${
            copied ? 'scale-[1.18] opacity-100' : 'opacity-0 group-hover:opacity-50'
          }`}
        />
      ) : null}
      <span aria-live="polite" className="sr-only">
        {copied ? t('figma-dashboard.Copyable.d2d08c715e') : ''}
      </span>
    </button>
  );
}
