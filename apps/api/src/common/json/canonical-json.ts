import { createHash } from 'node:crypto';

/**
 * Canonical JSON: one document, one byte sequence, in any language.
 *
 * This exists because `inputHash` is computed independently by the System Layer
 * (TypeScript) and by Router Core (Python) over the same published snapshot. If the two
 * serializers disagree by a single byte the hashes never match and the contour silently
 * stops applying plans (context/43 section 5.2).
 *
 * `JSON.stringify` and `json.dumps` are not interchangeable. They agree on object and
 * string syntax but differ on numbers: JavaScript prints `55` for the value 55.0 where
 * Python prints `55.0`, and the two switch to exponential notation at different
 * magnitudes. The rules below remove that freedom.
 *
 * ## The specification
 *
 * 1. Object keys are sorted ascending by UTF-16 code unit (JavaScript's default string
 *    comparison; in Python, `sorted()` over `str`).
 * 2. No whitespace anywhere: `{"a":1,"b":[2,3]}`.
 * 3. Strings use standard JSON escaping. Non-ASCII characters are **not** escaped; the
 *    output is UTF-8 (in Python, `ensure_ascii=False`).
 * 4. A number that is an integer is written without a decimal point: `1789459200`.
 * 5. Any other number is written with **exactly seven decimal places**: `55.7600000`
 *    (in Python, `format(value, '.7f')`). Seven places is chosen for geographic
 *    coordinates, where it is about a centimetre -- far finer than any routing decision.
 * 6. `true`, `false` and `null` are written literally.
 * 7. Arrays keep their order. Order carries meaning here: `arrivalOrder` and `inputOrder`
 *    define the baseline and must not be re-sorted (context/33 section 5).
 * 8. `undefined`, `NaN`, infinities, functions and symbols are rejected. An absent value
 *    must be an explicit `null`, because "the field was missing" and "the value is
 *    unknown" are different statements (context/33 section 4).
 * 9. `bigint` is rejected: the read boundary converts it to a number first, so that the
 *    same value cannot be serialized two different ways.
 *
 * The rules are asserted by a fixed test vector. Router Core must reproduce the same
 * bytes and the same digest for that vector.
 */

const DECIMAL_PLACES = 7;

export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
  }
}

/** Serializes a value to the canonical string form. */
export function canonicalJson(value: unknown): string {
  return write(value, '$');
}

/** Canonical bytes; this is what gets hashed and what gets stored. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

/** SHA-256 of the canonical bytes, lower-case hex. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

function write(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return writeNumber(value, path);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new CanonicalJsonError(
        'bigint must be converted to a number at the read boundary before serialization',
        path,
      );
    case 'undefined':
      throw new CanonicalJsonError('undefined is not representable; use null', path);
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${typeof value} is not serializable`, path);
    default:
      break;
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => write(item, `${path}[${index}]`));
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) {
    throw new CanonicalJsonError(
      'Date is not serializable; absolute time is an integer number of Unix seconds',
      path,
    );
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // A key whose value is `undefined` is a mistake, not an omission: making it silently
    // disappear would change the hash depending on how the object was built.
    .map(([key, item]) => [key, write(item, `${path}.${key}`)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${item}`).join(',')}}`;
}

function writeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError('NaN and infinities are not representable', path);
  }
  if (Number.isInteger(value)) {
    // `Object.is` keeps -0 from printing as "0" in one language and "-0" in another.
    return Object.is(value, -0) ? '0' : value.toFixed(0);
  }
  return value.toFixed(DECIMAL_PLACES);
}
