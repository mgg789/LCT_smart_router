import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ParsedRegion, ParsedRequest } from '../../src/orchestrator/imports/dataset.parser';
import { rebaseToLiveHorizon } from '../../src/orchestrator/imports/dataset-import.service';

const MOSCOW_OFFSET_SEC = 3 * 60 * 60;
const DAY_SEC = 24 * 60 * 60;

/** Unix seconds for a Moscow wall-clock moment on the benchmark's own date. */
function moscow(day: string, hour: number, minute = 0): number {
  return Date.parse(`${day}T00:00:00.000Z`) / 1000 - MOSCOW_OFFSET_SEC + hour * 3600 + minute * 60;
}

function hourOfDay(at: number): number {
  return new Date((at + MOSCOW_OFFSET_SEC) * 1000).getUTCHours();
}

function request(start: number, end: number, externalId: string): ParsedRequest {
  return {
    workCategory: 'service',
    externalId,
    workTypeCode: 'local_repair',
    skill: 'local',
    normProfileCode: 'local_repair',
    normativeTravelDurationSec: 0,
    technicalDurationSec: 1800,
    documentationDurationSec: 0,
    serviceDurationSec: 1800,
    priority: 'normal',
    windowStartAt: start,
    windowEndAt: end,
    windowOrigin: 'explicit',
    district: null,
    addressText: 'Город Москва, ул.Окская, д. 32',
    region: 'east',
  };
}

/** The bundled benchmark: one historical date, windows between 10:00 and 22:00. */
function benchmark(): ParsedRegion {
  return {
    region: 'east',
    requests: [
      request(moscow('2026-08-17', 10), moscow('2026-08-17', 12), 'first'),
      request(moscow('2026-08-17', 18), moscow('2026-08-17', 20), 'evening'),
      request(moscow('2026-08-17', 20), moscow('2026-08-17', 22), 'last'),
    ],
    brigades: [],
    depot: null,
    warnings: [],
    errors: [],
  };
}

describe('rebaseToLiveHorizon', () => {
  it('keeps every window at the local hour it was quoted for', () => {
    // Imported late in the evening: the old wall-clock anchor moved 10:00 to 20:26 and
    // pushed the rest of the set past midnight, which is what left the ТЗ package with
    // night windows nobody could work.
    const rebased = rebaseToLiveHorizon(benchmark(), moscow('2026-09-28', 20, 26));

    assert.deepEqual(
      rebased.requests.map((item) => hourOfDay(item.windowStartAt)),
      [10, 18, 20],
    );
    assert.deepEqual(
      rebased.requests.map((item) => hourOfDay(item.windowEndAt)),
      [12, 20, 22],
    );
  });

  it('shifts by whole days, so relative distances inside the set survive', () => {
    const source = benchmark();
    const rebased = rebaseToLiveHorizon(source, moscow('2026-09-28', 9));
    const byId = new Map(source.requests.map((item) => [item.externalId, item]));
    const first = rebased.requests[0];
    const sourceFirst = byId.get(first?.externalId ?? '');
    assert.ok(first && sourceFirst);
    const shift = first.windowStartAt - sourceFirst.windowStartAt;

    assert.equal(shift % DAY_SEC, 0);
    for (const item of rebased.requests) {
      const original = byId.get(item.externalId);
      assert.ok(original);
      assert.equal(item.windowStartAt - original.windowStartAt, shift);
      assert.equal(item.windowEndAt - original.windowEndAt, shift);
    }
  });

  it('lands the horizon on the first day its own opening hour is still ahead', () => {
    // 09:00 is before the set opens at 10:00, so the package belongs to today.
    const today = rebaseToLiveHorizon(benchmark(), moscow('2026-09-28', 9));
    assert.equal(today.requests[0]?.windowStartAt, moscow('2026-09-28', 10));

    // 11:00 is past it, so the whole package moves to tomorrow rather than opening
    // in the past or being squeezed into the remaining hours.
    const tomorrow = rebaseToLiveHorizon(benchmark(), moscow('2026-09-28', 11));
    assert.equal(tomorrow.requests[0]?.windowStartAt, moscow('2026-09-29', 10));
  });

  it('gives a full-day window the whole rebased horizon', () => {
    const source = benchmark();
    const wide: ParsedRegion = {
      ...source,
      requests: [
        ...source.requests,
        {
          ...request(moscow('2026-08-17', 0), moscow('2026-08-17', 23), 'all-day'),
          windowOrigin: 'declared_full_day',
        },
      ],
    };
    const rebased = rebaseToLiveHorizon(wide, moscow('2026-09-28', 9));
    const allDay = rebased.requests.find((item) => item.externalId === 'all-day');

    assert.ok(allDay);
    assert.equal(allDay.windowStartAt, moscow('2026-09-28', 10));
    assert.equal(allDay.windowEndAt, moscow('2026-09-28', 22));
  });
});
