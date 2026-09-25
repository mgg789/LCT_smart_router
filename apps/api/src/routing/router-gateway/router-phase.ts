/**
 * Router phase owned by the system backend.
 *
 * Client requests read this record. They never call Router or the road API.
 * The background poller and the geometry queue are the only writers.
 */

export type RouterPhaseName = 'building' | 'ready' | 'error';

export interface RouterPhaseState {
  readonly phase: RouterPhaseName;
  readonly message: string | null;
  readonly geometryDone: number;
  readonly geometryTotal: number;
}

const idle: RouterPhaseState = {
  phase: 'ready',
  message: null,
  geometryDone: 0,
  geometryTotal: 0,
};

let state: RouterPhaseState = idle;

/** Current phase. A read does not touch Router. */
export function readRouterPhase(): RouterPhaseState {
  return state;
}

/** Replace the stored phase. Callers are the poller and the geometry queue. */
export function writeRouterPhase(patch: Partial<RouterPhaseState>): void {
  state = { ...state, ...patch };
}

/** Test isolation. Production never resets a live phase. */
export function resetRouterPhase(): void {
  state = idle;
}

/**
 * What the screen should show.
 *
 * A published task that is newer than the applied plan is `building` even
 * before the next poll. A stored error wins over that, so the screen shows
 * the failure instead of an endless progress bar.
 */
export function visibleRouterPhase(publishedAhead: boolean): RouterPhaseState {
  const stored = readRouterPhase();
  if (stored.phase === 'error') return stored;
  if (publishedAhead || stored.phase === 'building') {
    return { ...stored, phase: 'building', message: null };
  }
  return { ...stored, phase: 'ready' };
}
