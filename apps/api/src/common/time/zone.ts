/**
 * The deployment clock. `APP_TIME_ZONE` defaults to Europe/Moscow, which has no DST,
 * so a fixed +03:00 used to be exact. Every date boundary reads the configured zone
 * so a non-Moscow deployment does not silently keep Moscow midnight.
 */
export function configuredTimeZone(): string {
  const zone = process.env.APP_TIME_ZONE?.trim();
  return zone && zone.length > 0 ? zone : 'Europe/Moscow';
}

/** UTC offset of `timeZone` at `atSeconds`, in seconds east of UTC. */
export function timeZoneOffsetSeconds(atSeconds: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(atSeconds * 1000));
  const tzName = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!match) {
    return 0;
  }
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  return sign * (hours * 3600 + minutes * 60);
}

/**
 * Unix seconds of a local wall clock `YYYY-MM-DDTHH:MM:SS` in the configured zone.
 * For Europe/Moscow this matches the previous `+03:00` literals.
 */
export function zonedWallUnix(dateTime: string, timeZone = configuredTimeZone()): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(dateTime);
  const date = match?.[1];
  const hourText = match?.[2];
  const minuteText = match?.[3];
  if (!date || !hourText || !minuteText) return Number.NaN;
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const secondText = match?.[4];
  const second = secondText ? Number(secondText) : 0;
  const utcGuessSeconds = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
  return utcGuessSeconds - timeZoneOffsetSeconds(utcGuessSeconds, timeZone);
}

/** End of the local calendar day that contains `now`, as Unix seconds. */
export function zonedDayEnd(now: number, timeZone = configuredTimeZone()): number {
  const offset = timeZoneOffsetSeconds(now, timeZone);
  return (Math.floor((now + offset) / 86400) + 1) * 86400 - offset;
}
