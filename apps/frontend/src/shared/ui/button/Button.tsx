import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type ButtonVariant = 'accent' | 'ink';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Replaces the label while an action is in flight; the button stays disabled. */
  loading?: boolean;
  children: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  accent: 'bg-accent text-ink',
  ink: 'bg-ink text-white border border-white',
};

/**
 * Pill button of the NAVIX mockup: 41px tall, fully rounded, Inter SemiBold 14px
 * with -0.42px tracking. Sizes come from the Figma frame divided by two — the
 * mockup is drawn at 2x.
 */
export function Button({
  variant = 'accent',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'flex h-[41px] w-full items-center justify-center rounded-full px-5',
        'text-[14px] font-semibold tracking-[-0.42px]',
        'transition-opacity duration-150 disabled:cursor-not-allowed disabled:opacity-45',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        VARIANT_CLASS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
