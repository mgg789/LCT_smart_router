import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { buildManualDemo } from '../../scripts/manual-demo';
import { uploadDataPackageSchema } from '../../src/api/dto/data.dto';

describe('manual demo micro-set', () => {
  it('keeps four jobs, two engineers and their relative windows when rebasing the date', () => {
    const fixture = buildManualDemo('2026-09-21');
    assert.equal(fixture.requests.length, 4);
    assert.equal(fixture.engineers?.length, 2);
    assert.equal(fixture.engineers?.[0]?.shiftStartAt, Date.parse('2026-09-21T06:00:00Z') / 1000);
    assert.equal(fixture.requests[0]?.windowEndAt, Date.parse('2026-09-21T13:00:00Z') / 1000);
    assert.equal(
      uploadDataPackageSchema.safeParse({ ...fixture, operationId: randomUUID() }).success,
      true,
    );
  });
  it('rejects calendar overflow instead of silently importing another date', () => {
    assert.throws(() => buildManualDemo('2026-02-31'));
    assert.throws(() => buildManualDemo('tomorrow'));
  });
});
