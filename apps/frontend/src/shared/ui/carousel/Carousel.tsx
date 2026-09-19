import type { KeyboardEvent, PointerEvent, ReactNode, WheelEvent } from 'react';
import { useRef } from 'react';
import { cn } from '../../lib/cn';

export interface CarouselProps {
  children: ReactNode;
  /** Distance one arrow key press moves the strip, in pixels. */
  step?: number;
  'aria-label': string;
  className?: string;
}

/**
 * Horizontal strip that scrolls three ways: the wheel, the arrow keys and
 * dragging with the mouse.
 *
 * A vertical wheel is translated into horizontal movement, which is what a
 * dispatcher expects from a row of cards on a desktop with no touchpad.
 */
export function Carousel({ children, step = 260, className, ...rest }: CarouselProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startScroll: number } | null>(null);

  const scrollBy = (delta: number) => {
    stripRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (!strip) return;
    // A plain vertical wheel is the common case; take whichever axis moved more.
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    strip.scrollLeft += delta;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      scrollBy(step);
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      scrollBy(-step);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (!strip || event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScroll: strip.scrollLeft,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    const state = drag.current;
    if (!strip || !state || state.pointerId !== event.pointerId) return;
    const moved = event.clientX - state.startX;
    // Only take over the pointer once it is clearly a drag, so clicks still land.
    if (Math.abs(moved) < 4) return;
    strip.setPointerCapture(event.pointerId);
    strip.scrollLeft = state.startScroll - moved;
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (strip?.hasPointerCapture(event.pointerId)) strip.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  return (
    <section
      aria-label={rest['aria-label']}
      className={cn(
        'flex gap-5 overflow-x-auto pb-2',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        'cursor-grab active:cursor-grabbing',
        'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink',
        className,
      )}
      onKeyDown={onKeyDown}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onWheel={onWheel}
      ref={stripRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1 requires a scrollable region to be keyboard reachable, and tabindex="0" is the prescribed way to let the arrow keys reach this strip.
      tabIndex={0}
    >
      {children}
    </section>
  );
}
