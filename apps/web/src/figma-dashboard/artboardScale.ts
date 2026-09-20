import { useEffect, useState } from 'react';
import { FIGMA_ARTBOARD } from './fixtures';

/** Extra artboard units so overlays cover scale rounding at the viewport edge. */
const LETTERBOX_BLEED = 4;

/**
 * Fits the 1920×1080 mockup into the viewport without changing its internal layout.
 * At exactly 1920×1080 the scale is 1, so browser screenshots stay pixel-identical.
 */
export function useArtboardScale(): number {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const update = () => {
      setScale(Math.min(window.innerWidth / FIGMA_ARTBOARD.width, window.innerHeight / FIGMA_ARTBOARD.height));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return scale;
}

/**
 * Letterbox around the scaled artboard, in artboard units.
 * Overlays (modal dim, toast veil) extend by this so the page margins stay covered.
 */
export function measureLetterbox(
  scale: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const fit = Math.max(scale, 0.01);
  return {
    x: Math.max(0, (viewport.width - FIGMA_ARTBOARD.width * fit) / (2 * fit)) + LETTERBOX_BLEED,
    y: Math.max(0, (viewport.height - FIGMA_ARTBOARD.height * fit) / (2 * fit)) + LETTERBOX_BLEED,
  };
}

/**
 * Live letterbox for the current viewport and artboard scale.
 */
export function useLetterboxInsets(scale: number): { x: number; y: number } {
  const [insets, setInsets] = useState(() =>
    measureLetterbox(scale, { width: window.innerWidth, height: window.innerHeight }),
  );

  useEffect(() => {
    const update = () => {
      setInsets(measureLetterbox(scale, { width: window.innerWidth, height: window.innerHeight }));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [scale]);

  return insets;
}
