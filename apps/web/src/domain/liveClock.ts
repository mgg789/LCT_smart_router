import type { LiveWorkday } from '../api/live';

/**
 * Reads a wall-clock stamp on the clock the working day is actually run on.
 *
 * Audit timestamps stay wall-based on purpose (`business-clock.ts` in the API says so),
 * but the dispatcher's board is drawn entirely in business time: the header, the plan,
 * every window. A chat row stamped 20:03 under a header reading 09:15 is the same
 * moment told on two different clocks, which is unreadable. A running day maps the two
 * linearly, so the conversion is exact rather than a guess.
 *
 * Outside a running day the two clocks are the same thing and the stamp is returned
 * unchanged.
 */
export function businessAt(wallSec: number, day: LiveWorkday | null | undefined): number {
  if (!day || day.status !== 'running' || day.startedAtWallSec === null) return wallSec;
  const elapsed = wallSec - day.startedAtWallSec;
  // A stamp from before the day started belongs to the day's own opening moment; it has
  // no earlier business time to be told in.
  if (elapsed <= 0) return day.logicalStartAt;
  return day.logicalStartAt + Math.floor(elapsed * day.speedFactor);
}
