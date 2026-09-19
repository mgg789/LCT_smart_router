import markUrl from '../../assets/brand/navix-mark.png';
import { cn } from '../../lib/cn';

export interface LogoProps {
  /** Rendered size of the mark in pixels; the wordmark scales with it. */
  size?: number;
  /** Hides the NAVIX wordmark, leaving the mark alone (sidebar rail). */
  markOnly?: boolean;
  className?: string;
}

/**
 * NAVIX lock-up: the mark above the wordmark, as on the sign-in screen.
 *
 * The mark is drawn as a mask filled with `currentColor` rather than an `<img>`:
 * the only export the designer has supplied is a raster, and masking its alpha
 * lets the same file serve the ink mark on light surfaces and a white one on the
 * dark rail. Replace with a real `<svg>` as soon as one exists.
 */
export function Logo({ size = 84, markOnly = false, className }: LogoProps) {
  return (
    <div className={cn('flex flex-col items-center text-ink', className)}>
      <span
        aria-hidden
        className="bg-current"
        style={{
          width: size,
          height: size,
          maskImage: `url(${markUrl})`,
          maskSize: 'contain',
          maskRepeat: 'no-repeat',
          maskPosition: 'center',
        }}
      />
      {markOnly ? (
        <span className="sr-only">NAVIX</span>
      ) : (
        <span
          className="mt-5 font-display tracking-[0.64px]"
          style={{ fontSize: Math.round(size * 0.38) }}
        >
          NAVIX
        </span>
      )}
    </div>
  );
}
