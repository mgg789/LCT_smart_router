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

it('accepts numbered priorities and gives old profiles a default switch preset', async () => {
  const {
    parsePersonalObjectiveOrder,
    personalPolicyStoredSchema,
    PERSONAL_POLICY_PRESET_DEFAULTS,
    PERSONAL_OBJECTIVES,
  } = await import('../../src/orchestrator/policy/personal-policy');
  assert.deepEqual(parsePersonalObjectiveOrder('123456789'), [...PERSONAL_OBJECTIVES]);
  assert.deepEqual(
    parsePersonalObjectiveOrder('9, 8, 7, 6, 5, 4, 3, 2, 1'),
    [...PERSONAL_OBJECTIVES].reverse(),
  );
  assert.throws(() => parsePersonalObjectiveOrder('112345678'));
  const { preset: _preset, ...old } = PERSONAL_POLICY_DEFAULTS;
  assert.deepEqual(
    personalPolicyStoredSchema.parse({ ...old, version: 1, updatedAt: 100 }).preset,
    PERSONAL_POLICY_PRESET_DEFAULTS,
  );
});

it('applies only the five router switches on explicit selection and skips identical settings', async () => {
  const { applyPersonalPolicyRouterPreset } = await import(
    '../../src/orchestrator/policy/personal-policy-preset'
  );
  let current = {
    ...PERSONAL_POLICY_DEFAULTS.preset,
    lunchesEnabled: true,
    routerContextVersion: 'v1',
    accessBufferSec: 123,
  };
  let writes = 0;
  let lunchSyncs = 0;
  const router = {
    getTechnicalSettings: async () => current,
    updateTechnicalSettings: async (input: Record<string, unknown>) => {
      assert.equal(input.expectedContextVersion, 'v1');
      assert.equal(input.accessBufferSec, 123);
      // The ordinary-request switch belongs to the API selection transaction.
      assert.equal(input.ordinaryReplanningDisabled, undefined);
      writes += 1;
      current = { ...current, ...input };
    },
  };
  delete (current as Partial<typeof current>).ordinaryReplanningDisabled;
  const live = {
    synchronizeGlobalLunchSwitch: async () => {
      lunchSyncs += 1;
    },
  };
  await applyPersonalPolicyRouterPreset(
    router as never,
    live as never,
    PERSONAL_POLICY_DEFAULTS.preset,
  );
  await applyPersonalPolicyRouterPreset(
    router as never,
    live as never,
    PERSONAL_POLICY_DEFAULTS.preset,
  );
  assert.equal(writes, 1);
  assert.equal(lunchSyncs, 1);
});
