import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { simulationPatchHash, worsensPlan } from '../../src/orchestrator/simulator/simulation-store';

describe('simulation store', () => {
  it('hashes a policy patch the same way twice and treats a worse lateness as a warning', () => {
    const hash = simulationPatchHash({ policy_id: 'sla' });
    assert.equal(hash, simulationPatchHash({ policy_id: 'sla' }));
    assert.notEqual(hash, simulationPatchHash({ policy_id: 'eco' }));
    assert.equal(hash.length, 64);
    assert.equal(
      worsensPlan({
        assigned: -1,
        unassigned: 1,
        lateAssigned: 0,
        totalLatenessSec: 0,
        distanceKm: -1,
        transfers: 1,
        beforeLate: 0,
        afterLate: 0,
        beforeUnassigned: 1,
        afterUnassigned: 2,
      }),
      true,
    );
    assert.equal(
      worsensPlan({
        assigned: 1,
        unassigned: -1,
        lateAssigned: -1,
        totalLatenessSec: -30,
        distanceKm: 2,
        transfers: 1,
        beforeLate: 2,
        afterLate: 1,
        beforeUnassigned: 2,
        afterUnassigned: 1,
      }),
      false,
    );
  });
});
