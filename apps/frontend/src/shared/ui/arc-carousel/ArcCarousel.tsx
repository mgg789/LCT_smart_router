import type { KeyboardEvent, PointerEvent, ReactNode, WheelEvent } from 'react';
import { useRef } from 'react';
import { cn } from '../../lib/cn';

/**
 * Radius of the circle the cards are laid on. Measured from the mockup: the
 * neighbour sits 349px sideways and 46px lower than the front card, which is the
 * chord of a circle this wide.
 */
const RADIUS = 1350;
/** Angle between two neighbouring cards. */
const STEP_DEG = 15;
/** Cards drawn either side of the front one; the outermost pair is only a wrap buffer. */
const WINDOW = 3;
/** The outermost pair is invisible, so a card that wraps does it off screen. */
const VISIBLE = 2;
/** Wheel distance that advances the deck by one card. */
const WHEEL_STEP = 90;
/** Pointer distance that advances the deck by one card. */
const DRAG_STEP = 150;
/** Movement past which a pointer gesture is a drag and not a click. */
const DRAG_SLOP = 6;

export interface ArcCarouselProps<T> {
  items: T[];
  /** Index of the card at the top of the arc. */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  renderCard: (item: T, active: boolean) => ReactNode;
  cardWidth?: number;
  cardHeight?: number;
  'aria-label': string;
  className?: string;
}

/** Shortest signed distance from `active` to `index` around the ring. */
function cyclicOffset(index: number, active: number, length: number): number {
  const forward = (((index - active) % length) + length) % length;
  return forward > length / 2 ? forward - length : forward;
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/**
 * Pointer Capture is optional: jsdom does not implement it at all, so the deck
 * asks for it rather than assuming it.
 */
function grabPointer(element: Element, pointerId: number): void {
  if (typeof element.setPointerCapture === 'function') element.setPointerCapture(pointerId);
}

function releasePointer(element: Element, pointerId: number): void {
  if (typeof element.hasPointerCapture !== 'function') return;
  if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
}

/**
 * Deck of cards laid along an arc, endlessly: the front card sits at the top of
 * the circle and its neighbours fall away to both sides, tilting with the curve.
 *
 * The ring has no ends — stepping past the last card comes back to the first —
 * so the strip is drawn as a window around the active card rather than as a
 * list. The pair at the edge of that window is transparent, which is where a
 * card crosses from one side of the deck to the other unseen.
 *
 * It answers the wheel (either axis), the arrow keys and dragging with a mouse.
 */
export function ArcCarousel<T>({
  items,
  activeIndex,
  onActiveIndexChange,
  keyOf,
  labelOf,
  renderCard,
  cardWidth = 318,
  cardHeight = 238,
  className,
  ...rest
}: ArcCarouselProps<T>) {
  const wheelAcc = useRef(0);
  const drag = useRef<{ pointerId: number; startX: number; startIndex: number; moved: boolean }>({
    pointerId: -1,
    startX: 0,
    startIndex: 0,
    moved: false,
  });
  const suppressClick = useRef(false);

  const length = items.length;
  const step = (delta: number) => {
    if (length > 0 && delta !== 0) onActiveIndexChange(wrap(activeIndex + delta, length));
  };

  const onWheel = (event: WheelEvent<HTMLElement>) => {
    // A plain vertical wheel is the common case on a dispatcher's desk; take
    // whichever axis moved more and turn it into travel along the arc.
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    wheelAcc.current += delta;
    const steps = Math.trunc(wheelAcc.current / WHEEL_STEP);
    if (steps !== 0) {
      wheelAcc.current -= steps * WHEEL_STEP;
      step(steps);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startIndex: activeIndex,
      moved: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (state.pointerId !== event.pointerId || length === 0) return;
    const moved = event.clientX - state.startX;
    if (Math.abs(moved) < DRAG_SLOP) return;
    state.moved = true;
    grabPointer(event.currentTarget, event.pointerId);
    // Dragging to the right pulls the left-hand neighbour to the front.
    const target = wrap(state.startIndex - Math.round(moved / DRAG_STEP), length);
    if (target !== activeIndex) onActiveIndexChange(target);
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (state.pointerId !== event.pointerId) return;
    releasePointer(event.currentTarget, event.pointerId);
    // The click that follows a drag belongs to the gesture, not to a card.
    suppressClick.current = state.moved;
    state.pointerId = -1;
  };

  return (
    // A named region, which is the pattern WCAG prescribes for a scrollable
    // widget: it gives the arrow keys somewhere to land and names the deck for a
    // screen reader without pretending the cards are tabs.
    <section
      aria-label={rest['aria-label']}
      aria-roledescription="карусель"
      className={cn(
        'relative touch-pan-y select-none overflow-hidden',
        'cursor-grab active:cursor-grabbing',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        className,
      )}
      onKeyDown={onKeyDown}
      onPointerCancel={endDrag}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onWheel={onWheel}
      style={{ height: cardHeight + RADIUS * (1 - Math.cos((VISIBLE * STEP_DEG * Math.PI) / 180)) }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1 — the arrow keys have to reach the deck even when no card holds focus.
      tabIndex={0}
    >
      {items.map((item, index) => {
        const offset = cyclicOffset(index, activeIndex, length);
        if (Math.abs(offset) > WINDOW) return null;

        const angle = offset * STEP_DEG;
        const radians = (angle * Math.PI) / 180;
        const hidden = Math.abs(offset) > VISIBLE;
        const active = offset === 0;

        return (
          <button
            aria-current={active}
            aria-hidden={hidden}
            className="absolute top-0 left-1/2 origin-center overflow-hidden rounded-[20px] transition-[transform,opacity] duration-500 ease-out"
            key={keyOf(item)}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              onActiveIndexChange(index);
            }}
            style={{
              width: cardWidth,
              height: cardHeight,
              transform: `translate(-50%, 0) translate(${RADIUS * Math.sin(radians)}px, ${
                RADIUS * (1 - Math.cos(radians))
              }px) rotate(${angle}deg)`,
              zIndex: WINDOW + 1 - Math.abs(offset),
              opacity: hidden ? 0 : 1,
              pointerEvents: hidden ? 'none' : 'auto',
            }}
            tabIndex={hidden ? -1 : 0}
            title={labelOf(item)}
            type="button"
          >
            {renderCard(item, active)}
          </button>
        );
      })}
    </section>
  );
}
