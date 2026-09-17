import { describe, expect, it } from 'vitest';
import { parseDataUpload } from './dataUpload';

const request = {
  externalId: 'req-1',
  addressText: 'Москва, ул. Примерная, 1',
  lat: 55.75,
  lon: 37.61,
  serviceDurationSec: 3600,
  windowStartAt: 1_800_000_000,
  windowEndAt: 1_800_003_600,
  priority: 'normal',
  requiredSkill: 'connection',
} as const;

describe('data upload validation', () => {
  it('accepts a complete new-region package', () => {
    const parsed = parseDataUpload(
      JSON.stringify({
        schemaVersion: '1.0',
        mode: 'new_region',
        region: 'north_test',
        sourceVersion: '2026-09-17',
        requests: [request],
        depot: { addressText: 'База', lat: 55.7, lon: 37.6 },
        engineers: [
          {
            externalId: 'eng-1',
            displayName: 'Тестовый инженер',
            skills: ['connection'],
            transportType: 'car',
            start: { lat: 55.7, lon: 37.6 },
            shiftStartAt: 1_800_000_000,
            shiftEndAt: 1_800_028_800,
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.file.requests).toHaveLength(1);
  });

  it('rejects engineers in append mode and duplicate request ids', () => {
    const parsed = parseDataUpload(
      JSON.stringify({
        schemaVersion: '1.0',
        mode: 'append_requests',
        region: 'east',
        sourceVersion: '2',
        requests: [request, request],
        engineers: [],
      }),
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.join(' ')).toContain('append_requests');
      expect(parsed.issues.join(' ')).toContain('duplicate externalId');
    }
  });

  it('rejects malformed JSON without throwing', () => {
    expect(parseDataUpload('{')).toEqual({
      ok: false,
      issues: ['Файл не является корректным JSON.'],
    });
  });
});
