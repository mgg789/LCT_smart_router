import { useEffect, useState } from 'react';
import { FIGMA_ARTBOARD } from './fixtures';

/**
 * Overscan, in artboard units, for anything that has to reach past the canvas.
 * Covers the sub-pixel seam `zoom` leaves at the very edge of the viewport.
 */
export const ARTBOARD_BLEED = 4;

/**
 * Below this the dashboard is shrunk no further and the page scrolls instead.
 * A dispatcher's board is dense; past a point shrinking it only makes it
 * unreadable, and a scrollbar is the honest answer on a small laptop.
 */
const MIN_FIT = 0.5;

/** Scale and the room that scale leaves, both in artboard units. */
export interface ArtboardCanvas {
  scale: number;
  width: number;
  height: number;
}

function viewportOf(viewport?: { width: number; height: number }) {
  if (viewport) return viewport;
  if (typeof window === 'undefined') return FIGMA_ARTBOARD;
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Fit of the 1920×1080 mockup into a window. Used on the first paint so a
 * smaller viewport does not briefly layout the full artboard and clip the
 * right-edge avatar out of the accessibility tree.
 */
export function readArtboardScale(viewport?: { width: number; height: number }): number {
  const { width, height } = viewportOf(viewport);
  if (width === 0 || height === 0) return 1;
  return Math.max(MIN_FIT, Math.min(width / FIGMA_ARTBOARD.width, height / FIGMA_ARTBOARD.height));
}

/**
 * The canvas the dashboard is laid out on: the whole window, measured in the
 * drawing's own units.
 *
 * The scale is the smaller of the two ratios, so type is the same size in both
 * directions and nothing is squashed. What is left over on the other axis is
 * not a margin to be letterboxed away — the canvas is handed the whole window
 * and the board spreads into it, which is what a wide monitor or a laptop in
 * landscape is for. It never reports less than 1920×1080, the size everything
 * inside is drawn against, so on a small screen the spare becomes a scrollbar.
 */
export function readArtboardCanvas(viewport?: { width: number; height: number }): ArtboardCanvas {
  const { width, height } = viewportOf(viewport);
  const scale = readArtboardScale({ width, height });
  return {
    scale,
    // Floored: `zoom` multiplies these back out, and a canvas half a pixel
    // wider than the window would raise a scrollbar over nothing.
    width: Math.max(FIGMA_ARTBOARD.width, Math.floor(width / scale)),
    height: Math.max(FIGMA_ARTBOARD.height, Math.floor(height / scale)),
  };
}

/**
 * Fits the mockup to the viewport without changing its internal layout.
 * At exactly 1920×1080 the scale is 1, so browser screenshots stay
 * pixel-identical.
 */
export function useArtboardScale(): number {
  return useArtboardCanvas().scale;
}

/** Live canvas for the current window. */
export function useArtboardCanvas(): ArtboardCanvas {
  const [canvas, setCanvas] = useState(() => readArtboardCanvas());

  useEffect(() => {
    const update = () => {
      setCanvas((current) => {
        const next = readArtboardCanvas();
        return next.scale === current.scale &&
          next.width === current.width &&
          next.height === current.height
          ? current
          : next;
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return canvas;
}
