import { useEffect, useState } from 'react';

/**
 * From here a window is wide and tall enough that a phone column alone looks
 * stranded in it, and the app is better presented as a card on the canvas:
 * tablets in either orientation, netbooks, any desktop window.
 */
export const DECK_MIN_WIDTH = 900;
export const DECK_MIN_HEIGHT = 560;

/**
 * From here there is room for the column and a second card beside it — 520 and
 * 560 wide, the gap between them and the page padding — with the height to
 * make a card of either.
 */
export const PANE_MIN_WIDTH = 1180;
export const PANE_MIN_HEIGHT = 620;

/** How the client and engineer apps should present themselves in a window. */
export interface PhoneDeck {
  /** Card on the canvas rather than a bare column. */
  deck: boolean;
  /** Room for a second card beside the first. */
  pane: boolean;
}

/**
 * These apps are drawn as a 670×1455 phone screen and every size inside them
 * is a fraction of the column's width, so a wide window cannot be filled by
 * stretching them: a wider column only makes the same screen taller. What a
 * wide window can do is give the column somewhere to sit and put a second
 * screen next to it, which is what these two answers decide.
 *
 * A phone in landscape stays a plain column that scrolls. A card would spend
 * a sixth of an already short screen on padding, and the customer is holding a
 * phone either way.
 */
export function readPhoneDeck(viewport?: { width: number; height: number }): PhoneDeck {
  const width = viewport?.width ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
  const height = viewport?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight);
  return {
    deck: width >= DECK_MIN_WIDTH && height >= DECK_MIN_HEIGHT,
    pane: width >= PANE_MIN_WIDTH && height >= PANE_MIN_HEIGHT,
  };
}

/** Live answer for the current window. */
export function usePhoneDeck(): PhoneDeck {
  const [deck, setDeck] = useState(readPhoneDeck);

  useEffect(() => {
    const update = () => {
      setDeck((current) => {
        const next = readPhoneDeck();
        return next.deck === current.deck && next.pane === current.pane ? current : next;
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return deck;
}
