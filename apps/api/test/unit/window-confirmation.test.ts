import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Actor } from '../../src/auth/actor';
import {
  isWindowConfirmationRequired,
  mayChangeRequestWindow,
  requireWindowConfirmation,
  type WindowChange,
} from '../../src/orchestrator/requests/window-confirmation';

const actor: Actor = {
  kind: 'account',
  source: 'ui',
  id: 'dispatcher-session',
  role: 'dispatcher',
  tokenCategory: null,
  accountId: 'dispatcher',
};
const change: WindowChange = {
  requestId: 'request-a',
  version: 3,
  previousStartAt: 100,
  previousEndAt: 200,
  windowStartAt: 300,
  windowEndAt: 400,
};
function challenge(): string {
  try {
    requireWindowConfirmation(actor, change);
  } catch (error) {
    assert.ok(isWindowConfirmationRequired(error));
    return String(error.details.confirmation);
  }
  throw new Error('A changed window must require confirmation');
}

it('allows only the exact actor, request version and bounds that were confirmed', () => {
  const confirmed = { ...actor, windowChangeConfirmation: challenge() };
  assert.doesNotThrow(() => requireWindowConfirmation(confirmed, change));
  for (const changed of [
    { ...change, version: 4 },
    { ...change, requestId: 'other' },
    { ...change, windowEndAt: 500 },
  ]) {
    assert.throws(
      () => requireWindowConfirmation(confirmed, changed),
      isWindowConfirmationRequired,
    );
  }
  assert.throws(
    () => requireWindowConfirmation({ ...confirmed, id: 'other' }, change),
    isWindowConfirmationRequired,
  );
  assert.throws(
    () => requireWindowConfirmation({ ...confirmed, source: 'ai_run' }, change),
    isWindowConfirmationRequired,
  );
});

it('does not ask for unchanged bounds and refuses expired or forged approvals', () => {
  assert.doesNotThrow(() =>
    requireWindowConfirmation(actor, { ...change, windowStartAt: 100, windowEndAt: 200 }),
  );
  for (const token of ['1.forged', `${Math.floor(Date.now() / 1000) + 600}.forged`]) {
    assert.throws(
      () => requireWindowConfirmation({ ...actor, windowChangeConfirmation: token }, change),
      isWindowConfirmationRequired,
    );
  }
});

it('forces human approval for AI window writes regardless of guard score', () => {
  assert.equal(mayChangeRequestWindow('alert.resolve', { action: 'reschedule' }), true);
  assert.equal(mayChangeRequestWindow('alert.resolve', { action: 'move_window' }), true);
  assert.equal(mayChangeRequestWindow('request.update', { windowStartAt: 10 }), true);
  assert.equal(mayChangeRequestWindow('request.update', { addressText: 'address' }), false);
  assert.equal(mayChangeRequestWindow('alert.resolve', { action: 'add_engineer' }), false);
});
