import { z } from 'zod';
import { SysError } from '../../common/errors';
import { timeZoneOffsetSeconds } from '../../common/time/zone';

/**
 * The one place a tool argument's local date or time is turned into a Unix second.
 *
 * Models are reliably bad at epoch arithmetic (task brief for this change), so no tool
 * schema in this catalogue declares an epoch number: every moment a tool takes from the
 * model is a local `YYYY-MM-DD` date and/or `HH:MM` time, converted here the same way
 * `apps/web/src/domain/alerts.ts#alertWindowSeconds` converts a dispatcher's own
 * datetime-local input -- a fixed UTC offset looked up for the configured zone rather
 * than added or subtracted by guesswork on the server (context/43 section 5.3).
 */

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `YYYY-MM-DD`, the only date shape a tool argument may carry. */
export const localDateSchema = z
  .string()
  .regex(LOCAL_DATE_RE, 'Expected a local date as YYYY-MM-DD');

/** `HH:MM` in 24-hour time, the only time-of-day shape a tool argument may carry. */
export const localTimeSchema = z.string().regex(LOCAL_TIME_RE, 'Expected a local time as HH:MM');

/**
 * Converts a local calendar date and time-of-day in `timeZone` to Unix seconds.
 *
 * Looks up the zone's UTC offset at (approximately) the requested moment rather than at
 * "now": a request made in the evening for tomorrow morning must not be converted with
 * today's offset. `Europe/Moscow`, this deployment's only configured zone, never observes
 * daylight saving, so the one-shot lookup below is exact for it and a fair approximation
 * for any zone with a fractional-day DST transition falling on the requested date.
 */
export function localToUnixSeconds(date: string, time: string, timeZone: string): number {
  if (!LOCAL_DATE_RE.test(date)) {
    throw SysError.validationFailed('Expected a local date as YYYY-MM-DD', { date });
  }
  if (!LOCAL_TIME_RE.test(time)) {
    throw SysError.validationFailed('Expected a local time as HH:MM', { time });
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const utcGuessSeconds = Date.UTC(year, month - 1, day, hour, minute, 0) / 1000;
  const offsetSeconds = timeZoneOffsetSeconds(utcGuessSeconds, timeZone);
  return utcGuessSeconds - offsetSeconds;
}
