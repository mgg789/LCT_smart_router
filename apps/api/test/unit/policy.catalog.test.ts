import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_POLICY_ID,
  findPolicy,
  POLICIES,
} from '../../src/orchestrator/policy/policy.catalog';

describe('policy catalogue', () => {
  it('matches the five Router policy identifiers and uses compact by default', () => {
    assert.deepEqual(
      POLICIES.map((policy) => policy.policyId),
      ['fast', 'compact', 'sla', 'balanced', 'eco'],
    );
    assert.equal(DEFAULT_POLICY_ID, 'compact');
    assert.deepEqual(
      POLICIES.filter((policy) => policy.isDefault).map((policy) => policy.policyId),
      ['compact'],
    );
    for (const policy of POLICIES) {
      assert.equal(findPolicy(policy.policyId), policy);
      assert.deepEqual(policy.parameters, {});
    }
  });
});
