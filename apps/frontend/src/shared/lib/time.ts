/**
 * Rendering of the API's clock.
 *
 * Every absolute time in the contract is integer Unix seconds, and the zone
 * belongs to the render edge only (docs/frontend-api.md §1). The dispatcher works
 * in Moscow, so that zone is stated explicitly rather than inherited from the
 * machine the browser happens to run on.
 */
export const DISPATCH_TIME_ZONE = 'Europe/Moscow';

const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: DISPATCH_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});

const dayFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: DISPATCH_TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function toDate(unixSeconds: number): Date {
  return new Date(unixSeconds * 1000);
}

/** `HH:mm` in Moscow. */
export function formatTime(unixSeconds: number): string {
  return timeFormat.format(toDate(unixSeconds));
}

/** `15 сентября, 2026` — the day heading of the plan screen. */
export function formatDayTitle(unixSeconds: number): string {
  const parts = dayFormat.formatToParts(toDate(unixSeconds));
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  return `${day} ${month}, ${year}`;
}

/** `12:00-14:00` for a time window or a shift. */
export function formatRange(startSeconds: number, endSeconds: number): string {
  return `${formatTime(startSeconds)}-${formatTime(endSeconds)}`;
}

/** Whole minutes, rounded — the UI never claims second-level precision. */
export function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)} мин`;
}

/** Kilometres with no decimals, as the mockup prints them. */
export function formatKm(km: number): string {
  return `${Math.round(km)} км`;
}
