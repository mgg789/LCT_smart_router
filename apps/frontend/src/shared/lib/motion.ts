import { useReducedMotion } from 'framer-motion';

/**
 * The motion vocabulary of the NAVIX interface — the same curves and timings
 * `apps/web` animates with, so both dashboards move alike.
 *
 * Everything eases out on one curve: quick to start, long soft landing.
 */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/** Dialogs, dropdowns: short enough not to delay the hand that opened them. */
export const fade = { duration: 0.22, ease: EASE_OUT };
/** Content settling into place — cards, rows, a panel's body. */
export const fadeSoft = { duration: 0.28, ease: EASE_OUT };
/** A whole section replacing another. */
export const slide = { duration: 0.34, ease: EASE_OUT };
/** Something that follows the pointer's choice, like the rail's active capsule. */
export const springQuick = { type: 'spring', stiffness: 420, damping: 36, mass: 0.8 } as const;
/** Press feedback on a control. */
export const tap = { duration: 0.16 };

/** Delay between two neighbours of a list revealing one after another. */
const STAGGER_STEP = 0.04;
/** Past this many items the rest arrive together, so a long list is not a slideshow. */
const STAGGER_LIMIT = 12;

/** Transition for the `index`-th item of a list that reveals itself in order. */
export function staggered(index: number) {
  return { ...fadeSoft, delay: Math.min(index, STAGGER_LIMIT) * STAGGER_STEP };
}

/**
 * Whether the interface should move at all. People who asked their system for
 * reduced motion get every change instantly, which is also what the tests see.
 */
export function useMotionOn(): boolean {
  return !useReducedMotion();
}
