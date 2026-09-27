import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Actor } from '../../src/auth';
import type { OperationContext } from '../../src/operations';
import {
  PERSONAL_POLICY_ACTIVE_OWNER_KEY,
  PERSONAL_POLICY_DEFAULTS,
  personalPolicyUpdateSchema,
} from '../../src/orchestrator/policy/personal-policy';
import { PolicyService } from '../../src/orchestrator/policy/policy.service';
import type { Tx } from '../../src/persistence';

it('saves per-account policy without activation and refreshes only its owned active copy', async () => {
  const values = new Map<string, unknown>();
  let policyId = 'compact';
  let activeWrites = 0;
  const tx = {
    appState: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        values.has(where.key) ? { value: values.get(where.key) } : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { key: string };
        create: { value: unknown };
        update: { value: unknown };
      }) => {
        values.set(where.key, values.has(where.key) ? update.value : create.value);
      },
    },
    activePolicy: {
      findUnique: async () => ({ policyId }),
      update: async () => {
        activeWrites += 1;
      },
    },
  } as unknown as Tx;
  const service = new PolicyService();
  const context = {
    tx,
    actor: { accountId: 'alice', id: 'alice' } as Actor,
    now: 100,
    operationId: 'save',
  } satisfies OperationContext;
  const input = { ...PERSONAL_POLICY_DEFAULTS, expectedVersion: 0 };
  assert.equal((await service.personal(tx, 'alice')).profile, null);
  assert.equal((await service.savePersonal(context, input)).activeUpdated, false);
  assert.equal(activeWrites, 0);
  assert.equal((await service.personal(tx, 'bob')).profile, null);
  assert.equal(
    (await service.listFor(tx, 'alice')).some((policy) => policy.policyId === 'personal'),
    true,
  );
  await assert.rejects(() => service.savePersonal(context, input), /изменилась/);
  policyId = 'personal';
  values.set(PERSONAL_POLICY_ACTIVE_OWNER_KEY, 'alice');
  assert.equal(
    (await service.savePersonal(context, { ...input, expectedVersion: 1 })).activeUpdated,
    true,
  );
  assert.equal(activeWrites, 1);
  values.set(PERSONAL_POLICY_ACTIVE_OWNER_KEY, 'bob');
  assert.equal(
    (await service.savePersonal(context, { ...input, expectedVersion: 2 })).activeUpdated,
    false,
  );
  assert.equal(activeWrites, 1);
});

it('requires a complete bounded permutation rather than arbitrary router settings', () => {
  assert.equal(
    personalPolicyUpdateSchema.safeParse({ ...PERSONAL_POLICY_DEFAULTS, expectedVersion: 0 })
      .success,
    true,
  );
  assert.equal(
    personalPolicyUpdateSchema.safeParse({
      ...PERSONAL_POLICY_DEFAULTS,
      expectedVersion: 0,
      objectiveOrder: Array(9).fill('travel_time'),
    }).success,
    false,
  );
  assert.equal(
    personalPolicyUpdateSchema.safeParse({
      ...PERSONAL_POLICY_DEFAULTS,
      expectedVersion: 0,
      objectiveOrder: ['disable_emergency_priority'],
    }).success,
    false,
  );
});

it('permits only personal preference saving as the consultant write exception', async () => {
  const { buildAiActionCatalog } = await import('../../src/ai/operations/ai-action.catalog');
  const actions = buildAiActionCatalog({} as never);
  assert.deepEqual(actions.get('policy.personal.save')?.allowedProfiles, [
    'dispatcher_fix',
    'dispatcher_readonly',
  ]);
  assert.deepEqual(actions.get('policy.select')?.allowedProfiles, ['dispatcher_fix']);
  for (const [name, action] of actions) {
    if (name !== 'policy.personal.save')
      assert.equal(action.allowedProfiles.includes('dispatcher_readonly'), false);
  }
});
