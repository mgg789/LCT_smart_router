import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

/** The canvas every screen is drawn on (Figma: 1920×1080). Never smaller than this. */
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

interface Canvas {
  fit: number;
  width: number;
  height: number;
}

/**
 * The scale, and the canvas that scale leaves for the board to fill.
 *
 * The scale is the smaller of the two ratios, so type is the same size in both
 * directions and nothing has to be squashed. What is left over on the other axis
 * is not a margin: the canvas is given the whole window, measured in the
 * drawing's own units, and the board spreads into it — a wider screen gets a
 * wider map, a taller one a taller list. It never goes below 1920×1080, which is
 * what the drawing assumes, so on a small screen the spare is a scrollbar.
 */
function canvasFor(width: number, height: number): Canvas {
  const fit = fitFor(width, height);
  return {
    fit,
    // Floored: `zoom` multiplies these back out, and a canvas half a pixel wider
    // than the window would raise a scrollbar over nothing.
    width: Math.max(DESIGN_SCREEN.width, Math.floor(width / fit)),
    height: Math.max(DESIGN_SCREEN.height, Math.floor(height / fit)),
  };
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
 * the canvas below really is its stated width, children measure themselves in
 * the drawing's units, and nothing has to be told what the scale is. A transform
 * would leave the layout at full size and merely paint it smaller, which breaks
 * scrolling, hit-testing and anything that reads its own box.
 */
export function ScreenFit({ children }: { children: ReactNode }) {
  const [canvas, setCanvas] = useState<Canvas>(() =>
    typeof window === 'undefined'
      ? { fit: 1, width: DESIGN_SCREEN.width, height: DESIGN_SCREEN.height }
      : canvasFor(window.innerWidth, window.innerHeight),
  );

  useEffect(() => {
    const measure = () => setCanvas(canvasFor(window.innerWidth, window.innerHeight));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return (
    <div className="flex min-h-screen justify-center overflow-auto bg-canvas">
      <div
        style={{
          zoom: canvas.fit,
          width: canvas.width,
          height: canvas.height,
          flex: 'none',
        }}
      >
        {children}
      </div>
    </div>
  );
}
