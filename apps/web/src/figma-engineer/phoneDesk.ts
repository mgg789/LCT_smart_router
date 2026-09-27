import { useEffect, useState } from 'react';

/**
 * From here the window can hold the rail, a screen and a second pane beside it
 * with room to read both: 158 for the rail, 640 for the screen, the gaps and
 * page padding, and enough left over that the pane is worth having.
 */
export const DESK_MIN_WIDTH = 1180;

/**
 * A desk needs height as much as width. A wide but short window — a phone
 * turned sideways, a half-height browser — gets the phone column, which
 * scrolls, rather than two panes with three lines each.
 */
export const DESK_MIN_HEIGHT = 620;

/**
 * Whether the client and engineer apps should lay out as a desk.
 *
 * Both are drawn as a 670-wide phone screen whose every size is a fraction of
 * that width, so a desktop cannot be served by stretching the column — it only
 * makes the same screen taller. Below the threshold the apps stay the column
 * they were drawn as, in landscape too; above it they become a desk, which is
 * a different React tree and not a restyled one.
 */
export function readPhoneDesk(viewport?: { width: number; height: number }): boolean {
  const width = viewport?.width ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
  const height = viewport?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight);
  return width >= DESK_MIN_WIDTH && height >= DESK_MIN_HEIGHT;
}

/** Live answer for the current window. */
export function usePhoneDesk(): boolean {
  const [desk, setDesk] = useState(readPhoneDesk);

  useEffect(() => {
    const update = () => setDesk(readPhoneDesk());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return desk;
}
