# Canonical serialization of `RouterTaskSnapshot`

> Shared contract between the System Layer (TypeScript) and Router Core (Python).
> Implementation: [`apps/api/src/common/json/canonical-json.ts`](../../apps/api/src/common/json/canonical-json.ts).
> Canon: `context/33` sections 4 and 7, `context/43` section 5.2.

## Why this document exists

`input_hash` is computed **independently** on both sides: the System Layer hashes the
document it publishes, Router Core hashes the document it read. A result is only applied
when the two agree (`context/33` section 7). If the serializers differ by one byte the
hashes never match, every result is rejected as belonging to another snapshot, and the
contour quietly stops applying plans while every component reports itself healthy.

`JSON.stringify` and `json.dumps` are not interchangeable. They agree on object and string
syntax and disagree on numbers: JavaScript prints `55` for the value `55.0` where Python
prints `55.0`, and the two switch to exponential notation at different magnitudes. The
rules below remove that freedom.

## The rules

1. **Object keys are sorted** ascending by UTF-16 code unit — JavaScript's default string
   comparison, and Python's `sorted()` over `str`.
2. **No whitespace** anywhere: `{"a":1,"b":[2,3]}`.
3. **Strings** use standard JSON escaping. Non-ASCII characters are **not** escaped; the
   output is UTF-8. In Python that means `ensure_ascii=False`.
4. **A number that is an integer** is written without a decimal point: `1789459200`. The
   value `55.0` is an integer and is written `55`.
5. **Any other number** is written with **exactly seven decimal places**: `55.7600000`.
   In Python, `format(value, '.7f')`. Seven places is chosen for geographic coordinates,
   where it is about a centimetre — far finer than any routing decision.
6. `true`, `false` and `null` are written literally.
7. **Arrays keep their order.** Order carries meaning: `arrival_order` and `input_order`
   define the baseline and must never be re-sorted (`context/33` section 5).
8. **Rejected, not coerced:** `undefined`, `NaN`, infinities, dates, functions. A value
   that is absent must be an explicit `null`, because "the field was missing" and "the
   value is unknown" are different statements (`context/33` section 4).
9. **`bigint` is rejected.** The read boundary converts it to a number first, so one value
   cannot be serialized two different ways.

`input_hash` is `sha256(canonical_bytes)` in lower-case hex. The hash is stored **beside**
the document and never inside it: a hash cannot be part of its own input.

The document is serialized once, and the same string is both stored and hashed.
Re-serializing for the hash would leave room for the two to differ.

## Reference implementation (Python)

This is the Router Core side. It produces byte-identical output to the TypeScript
implementation for the vector below — verified, not assumed.

```python
import hashlib
import json


def canonical(value, path="$"):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("not representable at " + path)
        if value.is_integer():
            return str(int(value))
        return format(value, ".7f")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v, f"{path}[{i}]") for i, v in enumerate(value)) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0])
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":" + canonical(v, f"{path}.{k}")
            for k, v in items
        ) + "}"
    raise ValueError(f"unsupported {type(value)} at {path}")


def input_hash(document) -> str:
    return hashlib.sha256(canonical(document).encode("utf-8")).hexdigest()
```

Note the `bool` checks come before the `int` check: in Python `True` *is* an `int`, and
without that order a boolean would serialize as `1`.

## Golden vector

| File | What it is |
|---|---|
| [`fixtures/snapshot-golden.json`](./fixtures/snapshot-golden.json) | The input document, written with indentation and unsorted keys on purpose |
| [`fixtures/snapshot-golden.canonical.txt`](./fixtures/snapshot-golden.canonical.txt) | The exact canonical bytes (1607 bytes) |
| [`fixtures/snapshot-golden.sha256.txt`](./fixtures/snapshot-golden.sha256.txt) | The expected digest |

```
b4bb64543745ffe6ae743d40433b139c932b9eced64b62e8aa33825a726b4d2f
```

The vector deliberately contains the cases that break naive implementations: a coordinate
whose value is a whole number (`55.0`), a coordinate with more than seven significant
decimals, `null` in every nullable field, `lunch_taken` both true and false, an empty
`parameters` object, and nested objects whose keys are not in alphabetical order.

**Both sides must reproduce these bytes.** `apps/api/test/unit/canonical-json.test.ts`
asserts it for TypeScript; Router Core should assert the same file in its own suite. A
failure there is the early warning that would otherwise appear as "Router keeps computing
but no plan is ever applied".

## What is deliberately not in the snapshot

The customer's problem text, names and addresses; execution history; a computed ETA; the
road matrix; the internal tolerance; the map. Those are either the System Layer's own
business data or Router's separately connected resources (`context/33` section 3). The
hash covers the task and nothing else, so unrelated activity cannot invalidate a result.
