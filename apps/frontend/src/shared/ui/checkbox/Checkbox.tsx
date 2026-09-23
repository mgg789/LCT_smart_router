import { Check } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import { cn } from '../../lib/cn';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  children: ReactNode;
  error?: string;
}

/**
 * Square checkbox of the NAVIX mockup: 15px box, 3px radius, 1px ink border,
 * 7px gap to a 12px Inter Medium label with -0.36px tracking.
 */
export function Checkbox({ children, error, className, checked, ...rest }: CheckboxProps) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="w-full">
      <div className="flex items-start gap-[7px]">
        <span className="relative mt-px inline-flex size-[15px] shrink-0">
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            checked={checked}
            className={cn(
              'peer size-[15px] cursor-pointer appearance-none rounded-[3px] border border-ink bg-transparent',
              'checked:bg-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
              error && 'border-danger',
              className,
            )}
            id={id}
            type="checkbox"
            {...rest}
          />
          <Check
            aria-hidden
            className="pointer-events-none absolute inset-0 m-auto hidden size-[11px] text-white peer-checked:block"
            strokeWidth={3}
          />
        </span>
        <label
          className="max-w-[225px] cursor-pointer text-[12px] font-medium tracking-[-0.36px] text-ink"
          htmlFor={id}
        >
          {children}
        </label>
      </div>
      {error ? (
        <p className="mt-1.5 text-[11px] text-danger" id={errorId}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
