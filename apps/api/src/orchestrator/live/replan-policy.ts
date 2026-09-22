/** Product thresholds use logical seconds, never wall-clock polling intervals. */
export const MATERIAL_DELAY_SEC = 25 * 60;
export const NEXT_VISIT_GAP_SEC = 30 * 60;
export const NO_SHOW_SEC = 30 * 60;

/**
 * Maps a dispatcher availability change onto the LIVE line.
 *
 * Before the no-show deadline an engineer who has not opened the line stays
 * `pending`, so they can still check in themselves. After that deadline a
 * pending row is taken offline on the next clock tick, so an explicit
 * return to the shift must confirm the line or the restore does not stick.
 */
export function lineStatusAfterDispatcherAvailability(
  availability: 'online' | 'offline',
  lineStartedAt: bigint | null,
  liveNow: number,
  logicalStartAt: number,
): { lineStatus: 'pending' | 'online' | 'no_show_offline'; lineStartedAt: bigint | null } {
  if (availability === 'offline') return { lineStatus: 'no_show_offline', lineStartedAt };
  const pastNoShow = liveNow >= logicalStartAt + NO_SHOW_SEC;
  if (lineStartedAt !== null || pastNoShow) {
    return { lineStatus: 'online', lineStartedAt: lineStartedAt ?? BigInt(liveNow) };
  }
  return { lineStatus: 'pending', lineStartedAt: null };
}

/** A completed visit only releases useful slack; late finishes always request a solve. */
export function finishNeedsReplan(
  now: number,
  startedAt: number,
  norm: number,
  tolerance: number,
  nextStart: number | null,
): boolean {
  const deadline = startedAt + norm + tolerance;
  return (
    now > deadline || (now < deadline && nextStart !== null && nextStart - now > NEXT_VISIT_GAP_SEC)
  );
}

/** Forecasts inside the material band are handled by alerts, not by the solver. */
export function etaNeedsReplan(
  eta: number,
  plannedStart: number,
  norm: number,
  windowEnd: number,
): boolean {
  return eta - plannedStart > MATERIAL_DELAY_SEC || eta + norm - windowEnd > MATERIAL_DELAY_SEC;
}
