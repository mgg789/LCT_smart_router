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
 *
 * The element is allowed to arrive later than the hook. A screen that shows
 * «загружаем…» first mounts its real box only on a second render, and looking
 * for it once, at mount, would have found nothing and never looked again — the
 * box would then measure zero for as long as it was on screen.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const [element, setElement] = useState<HTMLElement | null>(null);

  // Deliberately without a dependency list: a ref's contents change without
  // telling anyone, so the only honest moment to compare is after each render.
  // The compare is the guard — nothing re-renders unless the element itself
  // changed.
  useEffect(() => {
    if (ref.current !== element) setElement(ref.current);
  });

  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return size;
}
