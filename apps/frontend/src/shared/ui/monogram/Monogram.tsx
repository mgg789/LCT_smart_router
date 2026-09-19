import { cn } from '../../lib/cn';

export interface MonogramProps {
  /** Full name, or an e-mail when that is all the API gives. */
  name: string;
  size?: number;
  /** The profile screen wants the photo's rounded square, not the avatar circle. */
  shape?: 'circle' | 'tile';
  className?: string;
}

/** First letters of the first two words, or of the address before the `@`. */
export function initialsOf(name: string): string {
  const source = name.includes('@') ? (name.split('@')[0] ?? '') : name;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.charAt(0));
  return letters.join('').toUpperCase() || '?';
}

/**
 * Stands in for the photo the mockup shows. The API carries no avatars, so a
 * deterministic monogram is the honest substitute for stock portraits.
 */
export function Monogram({ name, size = 48, shape = 'circle', className }: MonogramProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-ink font-semibold text-white',
        shape === 'circle' ? 'rounded-full' : 'rounded-[20px]',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initialsOf(name)}
    </span>
  );
}
