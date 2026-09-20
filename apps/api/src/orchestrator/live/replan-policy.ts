/** Product thresholds use logical seconds, never wall-clock polling intervals. */
export const MATERIAL_DELAY_SEC = 25 * 60;
export const NEXT_VISIT_GAP_SEC = 30 * 60;

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
