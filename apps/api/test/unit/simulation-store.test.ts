import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  russianDelta,
  simulationPatchHash,
  worsensPlan,
} from '../../src/orchestrator/simulator/simulation-store';
import type { RouterSimulation } from '../../src/routing/router-gateway';

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

  it('states engineer and reserve-crew counts so a model cannot invent a headcount', () => {
    const text = russianDelta({ policy_id: 'covering' }, {
      delta: {
        before: counts(3, 0, 4),
        after: counts(4, 1, 3),
        transfers: 7,
      },
    } as RouterSimulation);
    assert.match(text, /инженеров в работе 3→4/);
    assert.match(text, /дополнительных экипажей 0→1/);
    assert.match(text, /не люди со смены/);
  });
});

function counts(engineers: number, extra: number, unassigned: number) {
  return {
    assigned_count: 14 - unassigned,
    unassigned_count: unassigned,
    late_assigned_count: 0,
    total_lateness_sec: 0,
    distance_km: 37,
    engineers_used: engineers,
    additional_engineers: extra,
  };
}
