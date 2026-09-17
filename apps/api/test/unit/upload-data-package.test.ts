import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { uploadDataPackageSchema } from '../../src/api/dto/data.dto';

const request = {
  externalId: 'req-1',
  addressText: 'Moscow, Test street, 1',
  lat: 55.75,
  lon: 37.61,
  serviceDurationSec: 1800,
  windowStartAt: 1_800_000_000,
  windowEndAt: 1_800_003_600,
  priority: 'normal' as const,
  requiredSkill: 'connection' as const,
};

describe('uploaded planning package schema', () => {
  it('accepts a complete new region package', () => {
    const parsed = uploadDataPackageSchema.parse({
      operationId: randomUUID(),
      schemaVersion: '1.0',
      mode: 'new_region',
      region: 'north_2',
      sourceVersion: 'source-1',
      depot: { addressText: 'Depot', lat: 55.7, lon: 37.6 },
      engineers: [
        {
          externalId: 'eng-1',
          displayName: 'Engineer One',
          skills: ['connection'],
          transportType: 'car',
          start: { lat: 55.7, lon: 37.6 },
          shiftStartAt: 1_800_000_000,
          shiftEndAt: 1_800_028_800,
        },
      ],
      requests: [request],
    });
    assert.equal(parsed.region, 'north_2');
  });

  it('rejects duplicate IDs, bad windows and mode-specific fields', () => {
    const parsed = uploadDataPackageSchema.safeParse({
      operationId: randomUUID(),
      schemaVersion: '1.0',
      mode: 'append_requests',
      region: 'east',
      sourceVersion: 'source-2',
      depot: { addressText: 'Forbidden depot', lat: 55.7, lon: 37.6 },
      requests: [request, { ...request, windowEndAt: request.windowStartAt - 1 }],
    });
    assert.equal(parsed.success, false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message).join('; ');
      assert.match(messages, /forbidden/);
      assert.match(messages, /Duplicate externalId/);
      assert.match(messages, /windowEndAt/);
    }
  });

  it('rejects unknown fields instead of silently accepting a different structure', () => {
    const parsed = uploadDataPackageSchema.safeParse({
      operationId: randomUUID(),
      schemaVersion: '1.0',
      mode: 'append_requests',
      region: 'east',
      sourceVersion: 'source-3',
      requests: [{ ...request, accidentalField: true }],
    });
    assert.equal(parsed.success, false);
  });
});
