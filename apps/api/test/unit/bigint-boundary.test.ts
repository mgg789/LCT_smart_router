import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertNoBigInt,
  bigIntToSeconds,
  bigIntToSecondsOrNull,
  secondsToBigInt,
} from '../../src/common/time/bigint-boundary';

describe('bigint boundary', () => {
  it('converts a database bigint to a JSON-safe number', () => {
    assert.equal(bigIntToSeconds(1789459200n), 1789459200);
    assert.equal(bigIntToSecondsOrNull(null), null);
  });

  it('refuses to approximate a value outside the safe integer range', () => {
    assert.throws(() => bigIntToSeconds(2n ** 60n), RangeError);
  });

  it('widens seconds back to bigint and rejects non-integers', () => {
    assert.equal(secondsToBigInt(1789459200), 1789459200n);
    assert.throws(() => secondsToBigInt(1.5), RangeError);
  });

  it('detects an unconverted bigint anywhere in a response payload', () => {
    assert.doesNotThrow(() => assertNoBigInt({ a: 1, b: [{ c: 'x' }], d: null }));
    assert.throws(
      () => assertNoBigInt({ plan: { stops: [{ arrivalAt: 1n }] } }),
      /\$\.plan\.stops\[0\]\.arrivalAt/,
    );
  });
});
