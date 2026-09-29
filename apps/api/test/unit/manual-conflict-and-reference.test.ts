import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Actor } from '../../src/auth';
import { SysError } from '../../src/common/errors';
import { assertManualConflictResolved } from '../../src/operations/manual-conflict-guard';
import { resolveRequestReference } from '../../src/orchestrator/requests/request-reference';
import type { Tx } from '../../src/persistence';
import { manualStateView } from '../../src/routing/router-gateway/manual-state';

it('resolves a unique visible prefix but refuses ambiguity', async () => {
  let matches = [{ id: '60ed9f3e-1111-2222-3333-444444444444' }];
  const tx = {
    request: { findUnique: async () => null, findMany: async () => matches },
  } as unknown as Tx;
  assert.equal((await resolveRequestReference(tx, '60ed9f3e')).id, matches[0]?.id);
  matches = [...matches, { id: '60ed9f3e-5555-2222-3333-444444444444' }];
  await assert.rejects(() => resolveRequestReference(tx, '60ed9f3e'), /неоднозначен/);
});

it('blocks dispatcher edits with every decision, permits recovery and LIVE facts', async () => {
  const state = {
    version: 3,
    workDate: '2026-09-27',
    reason: 'test',
    decisions: [
      { id: 'first', kind: 'assignment' as const, targetId: 'request1', priority: 0 },
      { id: 'second', kind: 'assignment' as const, targetId: 'request2', priority: 0 },
    ],
    acknowledgedConflicts: [],
    resolution: {
      acceptedIds: ['first'],
      rejectedIds: ['second'],
      conflictIds: ['first', 'second'],
      inputHash: 'hash',
    },
  };
  const tx = {
    controlState: { findUnique: async () => ({ mode: 'manual' }) },
    appState: { findUnique: async () => ({ value: state }) },
  } as unknown as Tx;
  const actor = { role: 'dispatcher', tokenCategory: null } as Actor;
  const request = { actor, operationId: 'test', action: 'request.update', payload: {} };
  await assert.rejects(
    () => assertManualConflictResolved(tx, request),
    (error: unknown) => {
      assert.ok(error instanceof SysError);
      assert.equal(error.details.kind, 'manual_conflict');
      assert.deepEqual(error.details.manual, manualStateView(state));
      return true;
    },
  );
  for (const action of [
    'manual.priorities',
    'manual.delete',
    'manual.decision.remove',
    'control.auto',
    'live.engineer.online',
    'request.fact.completed',
    'engineer.start_lunch',
    'ai.message.send',
  ]) {
    await assertManualConflictResolved(tx, { ...request, action });
  }
  await assertManualConflictResolved(tx, { ...request, actor: { ...actor, role: 'client' } });
  assert.equal(manualStateView({ ...state, resolution: null }).planningStatus, 'pending');
});
