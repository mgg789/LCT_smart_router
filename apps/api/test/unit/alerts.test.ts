import assert from 'node:assert/strict';
import test from 'node:test';
import { alertActionsFor, resolutionDelay } from '../../src/orchestrator/alerts/alert-policy';
import {
  lunchCoverageWitness,
  policyCoverageRegressed,
} from '../../src/orchestrator/alerts/coverage-policy';

test('alert action catalogue exposes only dispatcher-approved actions', () => {
  assert.deepEqual(alertActionsFor('time_risk'), [
    'reschedule',
    'move_window',
    'add_engineer',
    'keep_as_is',
  ]);
  assert.deepEqual(alertActionsFor('engineer_overdue'), ['message', 'remove_shift', 'extend']);
  assert.deepEqual(alertActionsFor('plan_rebuilt'), []);
  assert.equal(alertActionsFor('time_risk').includes('ai' as never), false);
});

test('the first three minutes do not produce a resolution-delay metric', () => {
  assert.equal(resolutionDelay(0), null);
  assert.equal(resolutionDelay(180), null);
  assert.equal(resolutionDelay(181), 1);
  assert.equal(resolutionDelay(420), 240);
});

test('policy coverage compares counts, not request identity', () => {
  assert.equal(policyCoverageRegressed(['old-a', 'old-b'], ['new-a', 'new-b']), false);
  assert.equal(policyCoverageRegressed(['old-a', 'old-b'], ['new-a']), true);
  // Completed/cancelled requests are removed from the baseline before this helper is called.
  assert.equal(policyCoverageRegressed(['still-submitted'], []), true);
});

test('lunch conflict requires a future verified coverage-gain witness', () => {
  assert.deepEqual(
    lunchCoverageWitness({
      code: 'LUNCH_COVERAGE_GAIN',
      facts: { additional_assigned_count: 1, lunch_start_at: 10_000 },
    }),
    { additional_assigned_count: 1, lunch_start_at: 10_000 },
  );
  assert.equal(
    lunchCoverageWitness({ code: 'LUNCH_NOT_PLACED', facts: { lunch_start_at: 10_000 } }),
    null,
  );
});
