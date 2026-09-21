import { cn } from '../../lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * 59×29 pill switch of the policy popover: ink track, white knob that slides.
 *
 * The knob position is the only visual difference between the states, as drawn —
 * `role="switch"` with `aria-checked` carries the meaning for anyone who cannot
 * read a 4px offset.
 */
export function Switch({ checked, onChange, label, disabled = false, className }: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        'relative h-[29px] w-[59px] shrink-0 rounded-full bg-ink transition-opacity',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        disabled && 'opacity-50',
        className,
      )}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          'absolute top-[4px] size-[21px] rounded-full bg-white transition-[left] duration-150',
          checked ? 'left-[34px]' : 'left-[4px]',
        )}
      />
    </button>
  );
}
