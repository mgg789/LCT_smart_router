import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ExpectedSmokePlan,
  matchesSmokePlan,
  type SmokePlanResponse,
} from '../../scripts/smoke-plan';

const expected: ExpectedSmokePlan = {
  requestIds: ['urgent'],
  engineerId: 'engineer',
  inputHash: 'new-hash',
  minRevision: 5,
  previousResultId: 'old-result',
};
const applied: SmokePlanResponse = {
  mode: 'auto',
  plan: {
    revision: 6,
    origin: 'auto',
    planAsOf: 1789840663,
    assignments: [{ requestId: 'urgent', status: 'assigned', engineerId: 'engineer' }],
  },
  appliedResult: { resultId: 'new-result', inputHash: 'new-hash' },
  lastResult: { resultId: 'old-result', accepted: true, rejectionCode: null },
};

describe('smoke applied-plan evidence', () => {
  it('accepts the applied plan when same-second diagnostics still point to the previous result', () => {
    assert.equal(matchesSmokePlan(applied, expected), true);
  });
  it('does not accept diagnostics without an applied relation', () => {
    assert.equal(matchesSmokePlan({ ...applied, appliedResult: null }, expected), false);
  });
  it('rejects the wrong task hash even if requests and revision look current', () => {
    assert.equal(
      matchesSmokePlan(
        { ...applied, appliedResult: { resultId: 'new-result', inputHash: 'another-task' } },
        expected,
      ),
      false,
    );
  });
  it('requires both a new revision and a new applied result for the urgent event', () => {
    assert.equal(matchesSmokePlan(applied, { ...expected, minRevision: 6 }), false);
    assert.equal(matchesSmokePlan(applied, { ...expected, previousResultId: 'new-result' }), false);
  });
  it('rejects a missing assignment, the wrong engineer, and manual state', () => {
    assert.equal(matchesSmokePlan(applied, { ...expected, requestIds: ['missing'] }), false);
    assert.equal(matchesSmokePlan(applied, { ...expected, engineerId: 'other' }), false);
    assert.equal(matchesSmokePlan({ ...applied, mode: 'manual' }, expected), false);
  });
});
