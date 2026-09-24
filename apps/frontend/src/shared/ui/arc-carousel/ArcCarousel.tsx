import type { KeyboardEvent, PointerEvent, ReactNode, WheelEvent } from 'react';
import { useRef } from 'react';
import { cn } from '../../lib/cn';
import { useElementSize } from '../../lib/useElementSize';

/** Width the mockup is drawn at; every measurement below is taken from it. */
const DESIGN_WIDTH = 1920;
/**
 * Where each card sits and how far it is tilted, measured off the drawing
 * (Figma 29:372) at its own 1920-wide canvas.
 *
 * Not a single circle: the drawing tilts a card far more than its place on the
 * arc would imply — the neighbour is 20° at 427px out, the one past it 60° at
 * 831px — so placement and tilt are two separate readings of the same fan rather
 * than one radius shared by both. The numbers are the card centres' offsets from
 * the front card, taken from the rotated frames' own boxes.
 */
const PLACE: Record<number, { x: number; y: number; tilt: number }> = {
  0: { x: 0, y: 0, tilt: 0 },
  1: { x: 427, y: 57, tilt: 20 },
  2: { x: 831, y: 298, tilt: 60 },
  // Past the drawing: a wrap buffer nobody sees, kept out of the way.
  3: { x: 1180, y: 620, tilt: 90 },
};

/** Cards drawn either side of the front one; the outermost pair is only a wrap buffer. */
const WINDOW = 3;
/** Wheel distance that advances the deck by one card. */
const WHEEL_STEP = 90;
/** Pointer distance that advances the deck by one card. */
const DRAG_STEP = 150;
/** Movement past which a pointer gesture is a drag and not a click. */
const DRAG_SLOP = 6;
/**
 * How visible a card is once it is this many places from the front.
 *
 * Every card the drawing shows is the same colour — the outermost pair is not
 * dimmed, it simply runs off the screen, and the fade belongs to the edge mask
 * below. Dimming them here instead made them read as a different, greyer kind of
 * card.
 */
const FADE: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 0 };

/** The furthest place from the front that is still drawn at all. */
const DEEPEST_VISIBLE = Math.max(
  ...Object.entries(FADE)
    .filter(([, opacity]) => opacity > 0)
    .map(([distance]) => Number(distance)),
);

/**
 * How far below the top of the box a card that many places from the front reaches.
 *
 * A tilted rectangle is `w·sin θ + h·cos θ` tall, so a box built for an upright
 * card is too short for every card but the front one — which is what used to cut
 * the outermost pair off along the bottom.
 */
function reachBelow(cardWidth: number, cardHeight: number, distance: number): number {
  const place = PLACE[distance] ?? PLACE[0];
  const radians = ((place?.tilt ?? 0) * Math.PI) / 180;
  return (
    (place?.y ?? 0) +
    cardHeight / 2 +
    (cardWidth * Math.sin(radians) + cardHeight * Math.cos(radians)) / 2
  );
}

export interface ArcCarouselProps<T> {
  items: T[];
  /** Index of the card at the top of the arc. */
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  renderCard: (item: T, active: boolean) => ReactNode;
  /** Card size at the design width; both shrink with the deck. */
  cardWidth?: number;
  cardHeight?: number;
  /** Height of the deck's box; by default one step of the curve past the card. */
  height?: number | string;
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
 * list. Cards dim as they travel outwards and the deck itself fades at both
 * ends, so a card crossing from one side of the ring to the other is never seen
 * to jump.
 *
 * The arc scales with the width it is given, and its box is one step of the
 * curve deep: the outer cards are cut off below, as the drawing cuts them at the
 * edge of the screen.
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
  cardWidth = 308,
  cardHeight = 229,
  height: boxHeight,
  className,
  ...rest
}: ArcCarouselProps<T>) {
  const hostRef = useRef<HTMLElement>(null);
  const wheelAcc = useRef(0);
  const drag = useRef<{ pointerId: number; startX: number; startIndex: number; moved: boolean }>({
    pointerId: -1,
    startX: 0,
    startIndex: 0,
    moved: false,
  });
  const suppressClick = useRef(false);

  const { width: hostWidth } = useElementSize(hostRef);
  /** Vertical room one unscaled deck needs for everything it actually shows. */
  const span = reachBelow(cardWidth, cardHeight, DEEPEST_VISIBLE);
  /**
   * Only the width decides the size.
   *
   * The drawing lets the fan run past the bottom and both sides of the screen —
   * that overhang is the look, not an accident — so a short box must not shrink
   * the cards to fit inside it. It does not clip them either; the glow at the
   * corners is what ends the deck.
   */
  const scale = hostWidth > 0 ? Math.min(1, Math.max(0.55, hostWidth / DESIGN_WIDTH)) : 1;
  const width = cardWidth * scale;
  const height = cardHeight * scale;

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
        'relative touch-pan-y select-none',
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
      ref={hostRef}
      style={{ height: boxHeight ?? span * scale }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: WCAG 2.1.1 — the arrow keys have to reach the deck even when no card holds focus.
      tabIndex={0}
    >
      {items.map((item, index) => {
        const offset = cyclicOffset(index, activeIndex, length);
        const distance = Math.abs(offset);
        if (distance > WINDOW) return null;

        // The drawing places and tilts a card by how far it is from the front; the
        // side it is on only decides which way both go.
        const place = PLACE[distance] ?? PLACE[0];
        const side = Math.sign(offset);
        const opacity = FADE[distance] ?? 0;
        const active = offset === 0;

        return (
          <button
            aria-current={active}
            aria-hidden={opacity === 0}
            className="absolute top-0 left-1/2 origin-center overflow-hidden rounded-[1.25em] transition-[transform,opacity] duration-500 ease-out"
            key={keyOf(item)}
            onClick={() => {
              if (suppressClick.current) {
                suppressClick.current = false;
                return;
              }
              onActiveIndexChange(index);
            }}
            style={{
              width,
              height,
              // The face is written in `em`, so its type and padding scale with the card.
              fontSize: 16 * scale,
              transform: `translate(-50%, 0) translate(${side * (place?.x ?? 0) * scale}px, ${
                (place?.y ?? 0) * scale
              }px) rotate(${side * (place?.tilt ?? 0)}deg)`,
              zIndex: WINDOW + 1 - distance,
              opacity,
              pointerEvents: opacity === 0 ? 'none' : 'auto',
            }}
            tabIndex={opacity === 0 ? -1 : 0}
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
