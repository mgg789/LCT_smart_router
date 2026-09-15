import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CanonicalJsonError,
  canonicalHash,
  canonicalJson,
} from '../../src/common/json/canonical-json';

describe('canonical json', () => {
  it('sorts object keys and emits no whitespace', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  });

  it('does not depend on the order the object was built in', () => {
    const one: Record<string, unknown> = {};
    one.z = 1;
    one.a = 2;
    const other: Record<string, unknown> = {};
    other.a = 2;
    other.z = 1;
    assert.equal(canonicalJson(one), canonicalJson(other));
  });

  it('keeps array order, because order carries the baseline', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  });

  it('writes integers without a decimal point and other numbers with exactly seven', () => {
    assert.equal(canonicalJson(1789459200), '1789459200');
    // The value 55.0 is an integer: JavaScript would print `55` and Python `55.0`, so the
    // rule names one of them.
    assert.equal(canonicalJson(55.0), '55');
    assert.equal(canonicalJson(55.76), '55.7600000');
    assert.equal(canonicalJson(37.6173), '37.6173000');
    assert.equal(canonicalJson(-0), '0');
  });

  it('keeps non-ASCII characters literal rather than escaping them', () => {
    assert.equal(canonicalJson({ city: 'Москва' }), '{"city":"Москва"}');
  });

  it('rejects values that would serialize ambiguously', () => {
    assert.throws(() => canonicalJson({ a: undefined }), CanonicalJsonError);
    assert.throws(() => canonicalJson(Number.NaN), CanonicalJsonError);
    assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), CanonicalJsonError);
    assert.throws(() => canonicalJson(1n), CanonicalJsonError);
    assert.throws(() => canonicalJson(new Date()), CanonicalJsonError);
  });

  it('names the path of the offending value', () => {
    assert.throws(
      () => canonicalJson({ engineers: [{ availableFrom: undefined }] }),
      /\$\.engineers\[0\]\.availableFrom/,
    );
  });

  it('hashes the bytes, so equal documents hash equally regardless of key order', () => {
    assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
    assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
    assert.match(canonicalHash({}), /^[0-9a-f]{64}$/);
  });
});
