/**
 * Absolute time inside the system is always an integer number of Unix seconds, never
 * milliseconds and never a localized string (context/33 section 4). Local dates exist
 * only at the input and output edges of the application.
 */
export type UnixSeconds = number;

/** Duration in whole seconds. Non-negative; a work or lunch duration must be positive. */
export type DurationSeconds = number;

export function isUnixSeconds(value: unknown): value is UnixSeconds {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function toUnixSeconds(date: Date): UnixSeconds {
  return Math.floor(date.getTime() / 1000);
}

export function fromUnixSeconds(seconds: UnixSeconds): Date {
  return new Date(seconds * 1000);
}

/**
 * Renders stored seconds in the configured zone for humans.
 *
 * The offset is applied by the formatter; it is never added to the stored value, so the
 * same timestamp read twice cannot drift (context/43 section 5.3).
 */
export function formatUnixSeconds(seconds: UnixSeconds, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(fromUnixSeconds(seconds));
}
