import type { DurationSeconds, UnixSeconds } from './unix-seconds';

/**
 * PostgreSQL stores every timestamp and duration as BIGINT, which the driver hands back
 * as a JavaScript `bigint`. `JSON.stringify` cannot serialize that type at all, so the
 * conversion has to happen deliberately at the boundary rather than by a global
 * `toJSON` patch that would silently turn numbers into strings (context/43 section 5.3).
 */

/**
 * Narrows a database `bigint` to a JSON-safe number.
 *
 * Throws instead of rounding: a timestamp that cannot survive the conversion is a data
 * problem worth failing on, not a value to approximate.
 */
export function bigIntToSeconds(value: bigint): UnixSeconds {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(
      `BIGINT ${value.toString()} is outside the JSON-safe integer range and cannot be exposed`,
    );
  }
  return asNumber;
}

export function bigIntToSecondsOrNull(value: bigint | null): UnixSeconds | null {
  return value === null ? null : bigIntToSeconds(value);
}

/** Widens an API-side integer back to the database representation. */
export function secondsToBigInt(value: UnixSeconds | DurationSeconds): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${value} is not an integer number of seconds`);
  }
  return BigInt(value);
}

/**
 * Guards the HTTP response encoder.
 *
 * Any `bigint` still present when a payload is serialized means some read path skipped
 * its boundary conversion; surfacing it as a 500 is better than shipping a string where
 * the contract promises a number.
 */
export function assertNoBigInt(value: unknown, path = '$'): void {
  if (typeof value === 'bigint') {
    throw new TypeError(`Unconverted bigint reached JSON serialization at ${path}`);
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoBigInt(item, `${path}[${index}]`);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoBigInt(item, `${path}.${key}`);
    }
  }
}
