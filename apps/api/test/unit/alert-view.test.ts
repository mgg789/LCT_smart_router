import assert from 'node:assert/strict';
import test from 'node:test';
import { toAlertView } from '../../src/orchestrator/alerts/alert-view';

test('toAlertView presents notices without dispatcher actions', () => {
  const view = toAlertView({
    id: 'notice-1',
    kind: 'notice',
    code: 'plan_rebuilt',
    severity: 'info',
    engineerIds: [],
    requestIds: [],
    reasons: { resultId: 'r1' },
    restoreOption: null,
    createdAt: 100n,
    seenAt: null,
    resolvedAt: null,
    resolutionAction: null,
    resolutionReason: null,
    resolutionDelaySec: null,
    workDate: null,
  });

  assert.deepEqual(view.actions, []);
  assert.deepEqual(view.reasons, [{ resultId: 'r1' }]);
  assert.equal(view.createdAt, 100);
});
