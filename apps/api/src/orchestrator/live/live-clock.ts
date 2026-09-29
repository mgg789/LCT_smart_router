/**
 * Wall time mapped onto a running LIVE workday.
 *
 * `speedDurationSec === null` keeps a 1:1 clock. A set value compresses the whole
 * logical span into that many wall seconds. Callers that publish or rebase a plan
 * must share this function: a wall-clock rebase during an accelerated morning
 * lands the package on the next calendar day and the live horizon drops it.
 */
export function acceleratedLiveNow(
  day: {
    readonly logicalStartAt: bigint | number;
    readonly logicalEndAt: bigint | number;
    readonly startedAtWallSec: bigint | number | null;
    readonly speedDurationSec: number | null;
  } | null,
  wallNow: number,
): number {
  if (day?.startedAtWallSec === null || day?.startedAtWallSec === undefined) return wallNow;
  const elapsed = Math.max(0, wallNow - Number(day.startedAtWallSec));
  const duration = Number(day.logicalEndAt) - Number(day.logicalStartAt);
  const factor = day.speedDurationSec === null ? 1 : duration / Number(day.speedDurationSec);
  return Number(day.logicalStartAt) + Math.floor(elapsed * factor);
}

/**
 * 08:00 local on a workday, before the official 10:00 opening.
 *
 * Rebase uses this instant so a pack opened in the evening still lands on the
 * day the dispatcher already started, not on the next calendar morning.
 */
export function workDateAnchor(workDate: string, offsetSec: number): number {
  const midnight = Date.parse(`${workDate}T00:00:00.000Z`) / 1000 - offsetSec;
  return midnight + 8 * 3600;
}
