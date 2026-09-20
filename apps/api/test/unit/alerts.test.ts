import assert from 'node:assert/strict';
import test from 'node:test';
import { alertActionsFor, resolutionDelay } from '../../src/orchestrator/alerts/alert-policy';

test('alert action catalogue exposes only dispatcher-approved actions', () => {
  assert.deepEqual(alertActionsFor('time_risk'), ['reschedule', 'move_window', 'add_engineer']);
  assert.deepEqual(alertActionsFor('engineer_overdue'), ['message', 'remove_shift', 'extend']);
  assert.deepEqual(alertActionsFor('plan_rebuilt'), []);
  assert.equal(alertActionsFor('time_risk').includes('ai' as never), false);
});

test('a blocking alert always offers at least one way out of the day', () => {
  // LIVE raises this one directly rather than through `refresh`, so it took the schema
  // defaults: `kind = 'alert'` and `isBlocking = true`. With an empty catalogue `resolve`
  // refused every action and `shift/close` kept counting it, so a single engineer forecast
  // that missed its window left the day impossible to close. Regression for that.
  assert.deepEqual(alertActionsFor('LIVE_WINDOW_COMPLETION_RISK'), [
    'reschedule',
    'move_window',
    'add_engineer',
  ]);
});

test('the first three minutes do not produce a resolution-delay metric', () => {
  assert.equal(resolutionDelay(0), null);
  assert.equal(resolutionDelay(180), null);
  assert.equal(resolutionDelay(181), 1);
  assert.equal(resolutionDelay(420), 240);
});
