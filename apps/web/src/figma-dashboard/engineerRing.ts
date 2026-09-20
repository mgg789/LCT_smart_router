/** Visible slots on the upper arc: −2 … +2 around the upright center card. */
export const RING_SLOT_SPAN = 2;

/**
 * One extra slot past the visible pair so a card mounts already posed, off-screen.
 * Spawn and the first degrees of rotation happen there, not in the corner.
 */
export const RING_RENDER_SPAN = RING_SLOT_SPAN + 1;

/** Equal angle between neighbouring card centres, in degrees. */
export const RING_ANGLE_STEP_DEG = 20;

/** Distance from the hidden ring origin to each card centre. */
export const RING_RADIUS = 1100;

export const RING_CARD = { width: 308, height: 229 } as const;

/**
 * Artboard point of the upright card's centre. 10px above Figma 49:5146
 * so chat, card and search sit as one cluster; spin arrivals target this.
 */
export const RING_CENTER = { x: 1037, y: 801 } as const;

/** Chat pill top, 31.5px above the upright card. */
export const RING_CHAT_TOP = RING_CENTER.y - RING_CARD.height / 2 - 82.5;

/** Search field top, 34.5px below the upright card. */
export const RING_SEARCH_TOP = RING_CENTER.y + RING_CARD.height / 2 + 34.5;

/** Circle origin sits below the artboard so only the upper arc is on screen. */
export const RING_ORIGIN = {
  x: RING_CENTER.x,
  y: RING_CENTER.y + RING_RADIUS,
} as const;

const LEAN_MAX_DEG = 4.5;
const OUTER_BLUR_PX = 16;

/**
 * Persistent slot offsets around the centre. These DOM nodes never remount.
 */
export function ringSlotKeys(span = RING_RENDER_SPAN): number[] {
  const keys: number[] = [];
  for (let k = -span; k <= span; k += 1) keys.push(k);
  return keys;
}

/** Pause after a key tap before hold-spin starts. */
export const RING_HOLD_DELAY_MS = 320;

/** Cards per second while an arrow key is held. */
export const RING_HOLD_CARDS_PER_SEC = 3.4;

/**
 * Signed slot of an engineer relative to the floating centre index.
 * Positive slots sit to the right. Clockwise rotation decreases `center`
 * (the upright card travels right, the left neighbour becomes the new centre).
 */
export function wrappedSlot(index: number, center: number, count: number): number {
  if (count <= 0) return 0;
  const raw = index - center;
  return raw - count * Math.round(raw / count);
}

/**
 * Cards farther than half a slot past the off-screen extra stay hidden.
 */
export function isRenderedSlot(slot: number): boolean {
  return Math.abs(slot) <= RING_RENDER_SPAN + 0.5;
}

/**
 * The five cards that sit on the visible upper arc (the extra pair is off-screen).
 */
export function isOnScreenSlot(slot: number): boolean {
  return Math.abs(slot) <= RING_SLOT_SPAN + 0.5;
}

export type RingCardPose = {
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  readonly rotateZ: number;
  readonly lean: number;
  readonly blur: number;
  readonly zIndex: number;
  readonly photo: number;
};

/**
 * Places one card on the upper arc. `lean` is a backward rotateX; the card's
 * bottom stays put and the top recedes. `blur` is the strength of the
 * location veil at that slot — it is not painted on the card itself.
 */
export function ringPose(slot: number): RingCardPose {
  const angleDeg = slot * RING_ANGLE_STEP_DEG;
  const angleRad = (angleDeg * Math.PI) / 180;
  const abs = Math.abs(slot);
  const t = Math.min(1, abs / RING_SLOT_SPAN);
  const outer = Math.max(0, (abs - 1) / RING_SLOT_SPAN);
  return {
    slot,
    x: RING_ORIGIN.x + RING_RADIUS * Math.sin(angleRad),
    y: RING_ORIGIN.y - RING_RADIUS * Math.cos(angleRad),
    rotateZ: angleDeg * 1.75,
    lean: abs < 0.08 ? 0 : LEAN_MAX_DEG * Math.min(1, abs),
    blur: OUTER_BLUR_PX * outer,
    zIndex: Math.round(24 - Math.abs(slot) * 6),
    photo: t,
  };
}

export type VisibleRingCard<T> = {
  readonly item: T;
  readonly index: number;
  readonly slot: number;
  readonly pose: RingCardPose;
  readonly logical: number;
};

export type RingMount = {
  readonly key: number;
  readonly index: number;
  readonly slot: number;
};

/**
 * Cyclic roster index. Negative values wrap the same way as a JS modulo should.
 */
export function wrapIndex(value: number, count: number): number {
  if (count <= 0) return 0;
  return ((value % count) + count) % count;
}

/**
 * Persistent mounts around the floating centre: five on-screen cards plus one
 * extra on each side. The same engineer can occupy two mounts so the incoming
 * copy stays posed off-screen instead of wrapping through the corner.
 */
export function ringMounts(center: number, count: number): RingMount[] {
  if (count <= 0) return [];
  const base = Math.round(center);
  const mounts: RingMount[] = [];
  for (let k = -RING_RENDER_SPAN; k <= RING_RENDER_SPAN; k += 1) {
    const logical = base + k;
    mounts.push({
      key: logical,
      index: wrapIndex(logical, count),
      slot: logical - center,
    });
  }
  return mounts;
}

/**
 * Cards on the upper arc plus the off-screen extras, in painter order.
 */
export function visibleRingCards<T>(items: readonly T[], center: number): VisibleRingCard<T>[] {
  if (items.length === 0) return [];
  return ringMounts(center, items.length)
    .map((mount) => ({
      item: items[mount.index] as T,
      index: mount.index,
      slot: mount.slot,
      pose: ringPose(mount.slot),
      logical: mount.key,
    }))
    .sort((left, right) => Math.abs(right.slot) - Math.abs(left.slot));
}

/**
 * Arrow-key step: right is clockwise (−1), left is counter-clockwise (+1).
 */
export function arrowSpinDelta(key: string): number | null {
  if (key === 'ArrowRight') return -1;
  if (key === 'ArrowLeft') return 1;
  return null;
}

/**
 * Unbounded centre that shows `selectedIndex`, or null if the ring already does.
 * Comparing the raw centre to a wrapped roster index (e.g. −1 vs 4) would
 * spin the ring the long way and look like a one-card rollback.
 */
export function selectionSpinTarget(
  center: number,
  selectedIndex: number,
  count: number,
): number | null {
  if (count <= 0 || selectedIndex < 0 || selectedIndex >= count) return null;
  if (wrapIndex(Math.round(center), count) === selectedIndex) return null;
  return center + shortestTurn(center, selectedIndex, count);
}

/**
 * Shortest signed step from one index to another on a cycle.
 * Positive = increasing centre = counter-clockwise; negative = clockwise.
 */
export function shortestTurn(from: number, to: number, count: number): number {
  if (count <= 1) return 0;
  const fromNorm = ((from % count) + count) % count;
  const toNorm = ((to % count) + count) % count;
  let delta = toNorm - fromNorm;
  if (delta > count / 2) delta -= count;
  if (delta < -count / 2) delta += count;
  return delta;
}

/**
 * Clockwise wheel / rightward drag lowers the centre index by one slot.
 */
export function wheelStep(deltaY: number): number {
  if (deltaY === 0) return 0;
  return deltaY > 0 ? -1 : 1;
}

/**
 * Angle from the ring origin to a pointer, 0 at the top, positive to the right.
 */
export function pointerAngleDeg(
  x: number,
  y: number,
  origin: { x: number; y: number } = RING_ORIGIN,
): number {
  return (Math.atan2(x - origin.x, origin.y - y) * 180) / Math.PI;
}

/**
 * Converts a pointer move around the origin into a centre-index delta.
 * Dragging right (clockwise on the upper arc) decreases the centre.
 */
export function rotationDeltaFromPointer(
  prev: { x: number; y: number },
  next: { x: number; y: number },
  origin: { x: number; y: number } = RING_ORIGIN,
): number {
  let delta = pointerAngleDeg(next.x, next.y, origin) - pointerAngleDeg(prev.x, prev.y, origin);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return -delta / RING_ANGLE_STEP_DEG;
}

/**
 * Higher is a better name / email hit. 0 means no match.
 */
export function scoreEngineerMatch(query: string, name: string, email: string | null): number {
  const needle = query.trim().toLocaleLowerCase('ru');
  if (!needle) return 0;
  const full = name.trim().toLocaleLowerCase('ru');
  const given = (name.trim().split(/\s+/)[0] ?? '').toLocaleLowerCase('ru');
  const mail = (email ?? '').trim().toLocaleLowerCase('ru');
  if (given.startsWith(needle)) return 120 - Math.min(given.length, 40);
  if (full.startsWith(needle)) return 90 - Math.min(full.length, 40);
  if (mail.startsWith(needle)) return 70;
  if (given.includes(needle)) return 50;
  if (full.includes(needle)) return 40;
  if (mail.includes(needle)) return 30;
  return 0;
}

/**
 * Best roster index for the query. Ties break toward the closer direction.
 */
export function bestEngineerIndex(
  items: readonly { name: string; email: string | null }[],
  query: string,
  center: number,
): number | null {
  if (!query.trim() || items.length === 0) return null;
  let best: { index: number; score: number; distance: number } | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const score = scoreEngineerMatch(query, item.name, item.email);
    if (score <= 0) continue;
    const distance = Math.abs(shortestTurn(center, index, items.length));
    if (
      !best ||
      score > best.score ||
      (score === best.score && distance < best.distance)
    ) {
      best = { index, score, distance };
    }
  }
  return best?.index ?? null;
}

/**
 * First token of a display name; brigades keep the surname after «Бригада».
 */
export function givenName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts[0] === 'Бригада' && parts[1]) return `${parts[0]} ${parts[1]}`;
  return parts[0] ?? displayName;
}
