import assert from 'node:assert/strict';
import { it } from 'node:test';
import { assertManualAssignmentEligibility } from '../../src/routing/router-gateway/manual-decisions.service';

it('rejects incompatible skill and transport but does not impose equipment-stock checks', () => {
  const request = {
    id: 'request',
    requiredSkill: 'connection' as const,
    requiredTransport: 'car' as const,
  };
  assert.throws(
    () =>
      assertManualAssignmentEligibility(request, {
        id: 'engineer',
        skills: ['local'],
        transportType: 'car',
      }),
    /навыка/,
  );
  assert.throws(
    () =>
      assertManualAssignmentEligibility(request, {
        id: 'engineer',
        skills: ['connection'],
        transportType: 'walk',
      }),
    /Транспорт/,
  );
  assert.doesNotThrow(() =>
    assertManualAssignmentEligibility(request, {
      id: 'engineer',
      skills: ['connection'],
      transportType: 'car',
    }),
  );
});
