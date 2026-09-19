import { useEffect, useState } from 'react';
import { FIGMA_ARTBOARD } from './fixtures';

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
