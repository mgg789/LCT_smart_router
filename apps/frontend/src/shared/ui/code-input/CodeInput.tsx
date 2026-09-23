import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from 'react';
import { useId, useRef } from 'react';
import { cn } from '../../lib/cn';

export interface CodeInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Number of cells; the login code is 6 digits (docs/frontend-api.md §2). */
  length?: number;
  error?: string;
  disabled?: boolean;
}

const DIGITS_ONLY = /\D/g;

/**
 * Per-digit code entry from the NAVIX mockup: white cells 48px tall with a 10px
 * radius. The mockup draws four cells, the contract sends a six-digit code, so the
 * cell count follows the contract and the row keeps the field width.
 *
 * `value` is the whole code — the cells are a presentation detail, so paste,
 * backspace and arrow navigation all operate on one string.
 */
export function CodeInput({
  label,
  value,
  onChange,
  length = 6,
  error,
  disabled = false,
}: CodeInputProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const cellRefs = useRef<Array<HTMLInputElement | null>>([]);

  const cells = Array.from({ length }, (_, index) => ({
    key: `${id}-cell-${index}`,
    index,
    digit: value[index] ?? '',
  }));

  const focusCell = (index: number) => {
    const clamped = Math.max(0, Math.min(length - 1, index));
    cellRefs.current[clamped]?.focus();
    cellRefs.current[clamped]?.select();
  };

  const writeAt = (index: number, raw: string) => {
    const cleaned = raw.replace(DIGITS_ONLY, '');
    if (cleaned === '') return;
    const next = (value.slice(0, index) + cleaned + value.slice(index + cleaned.length))
      .replace(DIGITS_ONLY, '')
      .slice(0, length);
    onChange(next);
    focusCell(index + cleaned.length);
  };

  const handleChange = (index: number) => (event: ChangeEvent<HTMLInputElement>) => {
    writeAt(index, event.target.value);
  };

  const handleKeyDown = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (value[index]) {
        onChange(value.slice(0, index) + value.slice(index + 1));
        return;
      }
      onChange(value.slice(0, Math.max(0, index - 1)) + value.slice(index));
      focusCell(index - 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusCell(index - 1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusCell(index + 1);
    }
  };

  const handlePaste = (index: number) => (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    writeAt(index, event.clipboardData.getData('text'));
  };

  return (
    <fieldset
      aria-describedby={error ? errorId : undefined}
      className="w-full min-w-0 border-0 p-0"
      disabled={disabled}
    >
      <legend className="font-display text-[16px] text-ink">{label}</legend>
      <div className="mt-[10px] flex gap-[7px]">
        {cells.map((cell) => (
          <input
            aria-invalid={error ? true : undefined}
            aria-label={`Цифра ${cell.index + 1}`}
            autoComplete={cell.index === 0 ? 'one-time-code' : 'off'}
            className={cn(
              'h-12 min-w-0 flex-1 rounded-[10px] bg-surface text-center',
              'text-[16px] font-semibold text-ink',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
              error && 'ring-1 ring-danger',
            )}
            inputMode="numeric"
            key={cell.key}
            onChange={handleChange(cell.index)}
            onKeyDown={handleKeyDown(cell.index)}
            onPaste={handlePaste(cell.index)}
            ref={(element) => {
              cellRefs.current[cell.index] = element;
            }}
            value={cell.digit}
          />
        ))}
      </div>
      {error ? (
        <p className="mt-1.5 text-[11px] text-danger" id={errorId}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
