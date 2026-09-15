import { SysError } from '../../common/errors';
import type { EngineerDay } from '../../generated/prisma/client';

/**
 * The local calendar day an engineer's state belongs to, as `YYYY-MM-DD`.
 *
 * A calendar day is not derivable from a Unix second without a zone, so the zone is
 * passed in explicitly rather than taken from the host. The absolute shift bounds stored
 * next to it remain the authoritative values; this key only groups them
 * (context/37 section 3.2).
 */
export function workDateOf(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(seconds * 1000));
}

export interface LunchConditions {
  readonly enabled: boolean;
  readonly durationSec?: number | null;
  readonly windowStartAt?: number | null;
  readonly windowEndAt?: number | null;
}

/**
 * Validates lunch conditions before they are stored.
 *
 * The concept is explicit that the hours and the duration of lunch have not been chosen
 * and must come from configuration before the feature is switched on; a function that is
 * enabled must not quietly run on an invented norm (context/32 section 8). So enabling
 * lunch without a duration and a full window is rejected rather than defaulted.
 *
 * `required = true` with `enabled = false` is contradictory and is refused outright
 * instead of picking the convenient half of the data (context/33 section 10.3).
 */
export function assertLunchConditions(input: LunchConditions, required: boolean): void {
  if (required && !input.enabled) {
    throw new SysError('VALIDATION_FAILED', 'A required lunch cannot also be disabled');
  }
  if (!input.enabled) {
    return;
  }
  const { durationSec, windowStartAt, windowEndAt } = input;
  if (!durationSec || durationSec <= 0) {
    throw new SysError('VALIDATION_FAILED', 'Enabling lunch needs a positive duration', {
      details: { durationSec: durationSec ?? null },
    });
  }
  if (windowStartAt == null || windowEndAt == null) {
    throw new SysError('VALIDATION_FAILED', 'Enabling lunch needs both window bounds');
  }
  if (windowEndAt <= windowStartAt) {
    throw new SysError('VALIDATION_FAILED', 'The lunch window ends before it starts');
  }
  // The whole lunch has to fit inside the window; a window shorter than the meal is a
  // configuration error, not a scheduling problem for Router to discover.
  if (windowEndAt - windowStartAt < durationSec) {
    throw new SysError('VALIDATION_FAILED', 'The lunch window is shorter than the lunch', {
      details: { durationSec, windowSec: windowEndAt - windowStartAt },
    });
  }
}

/**
 * Whether Router may still schedule lunch for this day.
 *
 * `lunchTaken` is the fact that the single lunch of the day has been used. It survives a
 * restart, a mode switch and turning the feature off and on again, and it outranks a
 * `required` flag left over from an earlier decision (context/33 section 10.3).
 */
export function lunchIsStillAvailable(day: EngineerDay): boolean {
  return day.lunchEnabled && !day.lunchTaken;
}
