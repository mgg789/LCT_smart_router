import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  localDateSchema,
  localTimeSchema,
  localToUnixSeconds,
} from '../../src/ai/tools/local-time';

describe('localToUnixSeconds', () => {
  it('converts a Moscow local date and time using the fixed +03:00 offset', () => {
    // 2026-09-20T14:30:00+03:00 == 2026-09-20T11:30:00Z (Europe/Moscow has no DST).
    const seconds = localToUnixSeconds('2026-09-20', '14:30', 'Europe/Moscow');
    assert.equal(seconds, Date.UTC(2026, 8, 20, 11, 30, 0) / 1000);
  });

  it('agrees with the web client for the same fixed-offset rule', () => {
    // Mirrors apps/web/src/domain/alerts.ts#alertWindowSeconds's own vector.
    const seconds = localToUnixSeconds('2026-01-15', '09:00', 'Europe/Moscow');
    assert.equal(seconds, Date.parse('2026-01-15T09:00:00+03:00') / 1000);
  });

  it('rejects a date or time that is not the expected local shape', () => {
    assert.throws(() => localToUnixSeconds('2026-1-1', '09:00', 'Europe/Moscow'));
    assert.throws(() => localToUnixSeconds('2026-01-01', '9:00', 'Europe/Moscow'));
    assert.throws(() => localToUnixSeconds('2026-01-01', '25:00', 'Europe/Moscow'));
  });
});

describe('local date/time zod schemas', () => {
  it('accept the exact YYYY-MM-DD and HH:MM shapes', () => {
    assert.equal(localDateSchema.safeParse('2026-09-20').success, true);
    assert.equal(localTimeSchema.safeParse('09:05').success, true);
  });

  it('reject an epoch number masquerading as a local value', () => {
    assert.equal(localDateSchema.safeParse(1_789_459_200).success, false);
    assert.equal(localTimeSchema.safeParse(1_789_459_200).success, false);
  });
});
