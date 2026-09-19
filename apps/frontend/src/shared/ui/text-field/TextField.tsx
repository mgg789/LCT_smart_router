import type { InputHTMLAttributes, Ref } from 'react';
import { useId } from 'react';
import { cn } from '../../lib/cn';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  /** Validation or API message shown under the field; also marks it invalid. */
  error?: string;
  /** Declared explicitly so `register()` from react-hook-form can attach here. */
  ref?: Ref<HTMLInputElement>;
}

/**
 * Labelled input of the NAVIX mockup: Murs Gothic label 16px, white field 48px tall
 * with a 10px radius and a 12px Inter placeholder in #B0B0B0.
 */
export function TextField({ label, error, className, ref, ...rest }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="w-full">
      <label className="block font-display text-[16px] text-ink" htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className={cn(
          'mt-[10px] h-12 w-full rounded-[10px] bg-surface px-[15px]',
          'text-[12px] font-medium text-ink placeholder:text-ink-faint',
          'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
          error && 'ring-1 ring-danger',
          className,
        )}
        id={id}
        ref={ref}
        {...rest}
      />
      {error ? (
        <p className="mt-1.5 text-[11px] text-danger" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
