import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Size of an element's content box, kept current.
 *
 * Stays `{0, 0}` until it is measured, and where there is no ResizeObserver at
 * all — jsdom — so a caller that scales itself to its box must read zero as
 * "not known yet" and fall back to its design size rather than collapsing.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
