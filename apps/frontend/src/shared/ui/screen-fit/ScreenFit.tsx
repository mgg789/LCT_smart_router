import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

/** The canvas every screen is drawn on (Figma: 1920×1080). */
export const DESIGN_SCREEN = { width: 1920, height: 1080 } as const;

/**
 * Below this the interface is shrunk no further; it scrolls instead.
 *
 * A dispatcher's board is dense, and past a point shrinking it only makes it
 * unreadable — a scrollbar is the honest answer on a small laptop, not type
 * nobody can read.
 */
const MIN_FIT = 0.5;

function fitFor(width: number, height: number): number {
  if (width === 0 || height === 0) return 1;
  return Math.max(MIN_FIT, Math.min(width / DESIGN_SCREEN.width, height / DESIGN_SCREEN.height));
}

/**
 * Scales the whole interface to the window without moving anything inside it.
 *
 * The drawing is laid out once, at its own size, and the window only chooses how
 * large that is — so every gutter, gap and overlap stays exactly as drawn on a
 * 13" laptop and on a 4K board alike. That is the point: fluid rules would let
 * each screen find its own arrangement, and the dispatcher would be learning a
 * slightly different board at every desk.
 *
 * `zoom` rather than `transform: scale`, because `zoom` takes part in layout:
 * the canvas below really is 1920 wide, children measure themselves in the
 * drawing's units, and nothing has to be told what the scale is. A transform
 * would leave the layout at full size and merely paint it smaller, which breaks
 * scrolling, hit-testing and anything that reads its own box.
 *
 * The scale is the smaller of the two ratios, so nothing is cut off; the spare
 * strip on the other axis is canvas colour, and the board stays centred in it.
 */
export function ScreenFit({ children }: { children: ReactNode }) {
  const [fit, setFit] = useState(() =>
    typeof window === 'undefined' ? 1 : fitFor(window.innerWidth, window.innerHeight),
  );

  useEffect(() => {
    const measure = () => setFit(fitFor(window.innerWidth, window.innerHeight));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return (
    <div className="flex min-h-screen justify-center overflow-auto bg-canvas">
      <div
        style={{
          zoom: fit,
          width: DESIGN_SCREEN.width,
          height: DESIGN_SCREEN.height,
          flex: 'none',
        }}
      >
        {children}
      </div>
    </div>
  );
}
