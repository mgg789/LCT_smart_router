/**
 * The takes, as the reel sees them.
 *
 * `footage.json` is written by `capture/encode.ts` and carries, for every take, the
 * encoded file, its size, the named instants the scene scripts marked, and the path the
 * cursor really travelled. The reel cuts against those marks rather than against hand
 * counted seconds, so a take that runs half a second long does not slide the edit.
 */
import manifest from './footage.json' with { type: 'json' };
import { FPS } from './theme.ts';

export interface PointerEvent {
  readonly t: number;
  readonly kind: 'move' | 'down' | 'up';
  readonly x: number;
  readonly y: number;
}

export interface FootageEntry {
  readonly scene: string;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly marks: Readonly<Record<string, number>>;
  readonly pointer: readonly PointerEvent[];
}

const entries = manifest as unknown as FootageEntry[];
const byScene = new Map(entries.map((entry) => [entry.scene, entry]));

export function hasShot(scene: string): boolean {
  return byScene.has(scene);
}

export function shot(scene: string): FootageEntry {
  const entry = byScene.get(scene);
  if (!entry) {
    throw new Error(
      `No footage for "${scene}". Film it with \`node capture/run.ts --only=${scene}\` ` +
        'and encode it with `node capture/encode.ts`.',
    );
  }
  return entry;
}

/** Whether the capture marked this instant. A missing mark is not the same as time zero. */
export function hasMark(scene: string, name: string): boolean {
  return byScene.get(scene)?.marks[name] !== undefined;
}

/** Seconds into a take for a named instant, falling back to the take's own start. */
export function mark(scene: string, name: string, fallback = 0): number {
  const value = byScene.get(scene)?.marks[name];
  return value === undefined ? fallback : value;
}

export function markFrames(scene: string, name: string, fallback = 0): number {
  return Math.round(mark(scene, name, fallback) * FPS);
}

/** Length of a take in whole frames. */
export function shotFrames(scene: string): number {
  return Math.floor(shot(scene).duration * FPS);
}

export interface CursorState {
  readonly x: number;
  readonly y: number;
  /** 0 released, 1 fully pressed — used for the ring that blooms out of a click. */
  readonly press: number;
  /** Seconds since the most recent press, or null if there has not been one. */
  readonly sincePress: number | null;
  readonly visible: boolean;
}

/**
 * Where the cursor was at a moment in a take.
 *
 * Headless Chrome paints no pointer, so the reel draws it back from the path the scene
 * script drove. Between two recorded samples the position is interpolated, which is what
 * makes a 20 fps take carry a 60 fps cursor.
 */
export function cursorAt(scene: string, seconds: number): CursorState {
  const track = byScene.get(scene)?.pointer ?? [];
  if (track.length === 0) {
    return { x: 0.5, y: 0.5, press: 0, sincePress: null, visible: false };
  }
  let previous = track[0] as PointerEvent;
  let next: PointerEvent | null = null;
  for (const event of track) {
    if (event.t <= seconds) previous = event;
    else {
      next = event;
      break;
    }
  }
  const span = next ? next.t - previous.t : 0;
  const blend = span > 0 ? Math.min(1, Math.max(0, (seconds - previous.t) / span)) : 0;
  const x = next ? previous.x + (next.x - previous.x) * blend : previous.x;
  const y = next ? previous.y + (next.y - previous.y) * blend : previous.y;

  let lastDown: number | null = null;
  let held = false;
  for (const event of track) {
    if (event.t > seconds) break;
    if (event.kind === 'down') {
      lastDown = event.t;
      held = true;
    }
    if (event.kind === 'up') held = false;
  }
  return {
    x,
    y,
    press: held ? 1 : 0,
    sincePress: lastDown === null ? null : seconds - lastDown,
    visible: seconds >= track[0].t - 0.4,
  };
}
