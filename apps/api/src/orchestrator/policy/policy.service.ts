import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SysError } from '../../common/errors';
import { canonicalHash } from '../../common/json';
import { Prisma } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import type { PolicyComparison } from '../../routing/router-gateway/router-client.port';
import { businessNow } from '../live/business-clock';
import {
  PERFORMANCE_POLICY_COMPARISON_PREFIX,
  PERFORMANCE_POLICY_SELECTION_PREFIX,
} from '../performance';
import {
  PERSONAL_POLICY_ACTIVE_OWNER_KEY,
  PERSONAL_POLICY_DEFAULTS,
  PERSONAL_POLICY_FIELDS,
  PERSONAL_POLICY_SWITCH_FIELDS,
  personalPolicyKey,
  personalPolicyStoredSchema,
  personalPolicyUpdateSchema,
} from './personal-policy';
import { DEFAULT_POLICY_ID, findPolicy, POLICIES, type PolicySpec } from './policy.catalog';
import { ORDINARY_REPLANNING_KEY, ordinaryReplanningDisabled } from './replanning-policy';

const evidenceSchema = z.object({
  version: z.literal(1),
  inputPublicationId: z.string(),
  inputHash: z.string(),
  routerContextVersion: z.string(),
  rosterHash: z.string(),
  rosterEngineerIds: z.array(z.string()),
  computedAt: z.number().int(),
  searchBudgetMs: z.number().int(),
  rows: z.array(
    z.object({
      strategyId: z.string(),
      kind: z.enum(['policy', 'baseline']),
      additionalEngineers: z.number().int(),
      isUsable: z.boolean(),
      calculationMs: z.number().int(),
      jobEnds: z.array(z.number().int().nonnegative()).default([]),
      metrics: z.record(z.string(), z.unknown()),
    }),
  ),
  savedAt: z.number().int(),
});

/**
 * The dispatcher's choice of policy.
 *
 * Choosing one changes the data of the task and republishes it; it does not switch a
 * solver implementation and does not edit weights. A rich policy structure in the
 * contracts does not create an editor in the Dashboard (context/42 DF-15).
 */
@Injectable()
export class PolicyService {
  /** Read the authenticated dispatcher's profile; defaults are guidance, not a saved policy. */
  async personal(tx: Tx, accountId: string | null) {
    const row = accountId
      ? await tx.appState.findUnique({ where: { key: personalPolicyKey(accountId) } })
      : null;
    const profile = row ? personalPolicyStoredSchema.parse(row.value) : null;
    return {
      policyId: 'personal' as const,
      profile,
      defaults: PERSONAL_POLICY_DEFAULTS,
      fields: PERSONAL_POLICY_FIELDS.map((field, index) => ({ ...field, number: index + 1 })),
      switchFields: PERSONAL_POLICY_SWITCH_FIELDS,
    };
  }

  /** Includes a personal choice only after this account has explicitly saved its profile. */
  async listFor(tx: Tx, accountId: string | null) {
    const { profile } = await this.personal(tx, accountId);
    return [
      ...POLICIES,
      ...(profile
        ? [
            {
              policyId: 'personal',
              title: profile.title,
              description:
                'Личная последовательность целей; ограничения и приоритет аварий сохраняются.',
              isDefault: false,
              parameters: { objective_order: profile.objectiveOrder.join(',') },
            },
          ]
        : []),
    ];
  }

  /** Durable CAS update. Never activates a profile; refreshes an already-active owned copy. */
  async savePersonal(context: OperationContext, input: z.infer<typeof personalPolicyUpdateSchema>) {
    const accountId = context.actor.accountId;
    if (!accountId) throw SysError.forbidden('Личная политика требует учётную запись диспетчера');
    const parsed = personalPolicyUpdateSchema.parse(input);
    const { profile } = await this.personal(context.tx, accountId);
    if ((profile?.version ?? 0) !== parsed.expectedVersion)
      throw new SysError('VERSION_CONFLICT', 'Личная политика изменилась. Прочитайте её заново.');
    const next = {
      title: parsed.title,
      objectiveOrder: parsed.objectiveOrder,
      preset: parsed.preset ?? profile?.preset ?? PERSONAL_POLICY_DEFAULTS.preset,
      version: parsed.expectedVersion + 1,
      updatedAt: context.now,
    };
    await context.tx.appState.upsert({
      where: { key: personalPolicyKey(accountId) },
      create: { key: personalPolicyKey(accountId), value: next, updatedAt: BigInt(context.now) },
      update: { value: next, updatedAt: BigInt(context.now) },
    });
    const active = await context.tx.activePolicy.findUnique({ where: { id: 'singleton' } });
    const owner = await context.tx.appState.findUnique({
      where: { key: PERSONAL_POLICY_ACTIVE_OWNER_KEY },
    });
    const activeUpdated = active?.policyId === 'personal' && owner?.value === accountId;
    if (activeUpdated)
      await context.tx.activePolicy.update({
        where: { id: 'singleton' },
        data: {
          parameters: { objective_order: next.objectiveOrder.join(',') },
          changedAt: BigInt(context.now),
          changedBy: context.actor.id,
          version: { increment: 1 },
        },
      });
    return { policyId: 'personal' as const, profile: next, activeUpdated };
  }

  /** Saves a comparison only under an immutable identity of input, Router context and roster. */
  async recordComparison(
    tx: Tx,
    comparison: PolicyComparison,
    rosterEngineerIds: readonly string[],
    savedAt: number,
  ): Promise<string> {
    const roster = [...rosterEngineerIds].sort();
    const rosterHash = canonicalHash(roster);
    const key = `${PERFORMANCE_POLICY_COMPARISON_PREFIX}${comparison.inputHash}:${comparison.routerContextVersion}:${rosterHash}`;
    const value = {
      version: 1 as const,
      inputPublicationId: comparison.inputPublicationId,
      inputHash: comparison.inputHash,
      routerContextVersion: comparison.routerContextVersion,
      rosterHash,
      rosterEngineerIds: roster,
      computedAt: comparison.computedAt,
      searchBudgetMs: comparison.searchBudgetMs,
      rows: comparison.rows.map((row) => ({
        strategyId: row.strategyId,
        kind: row.kind,
        additionalEngineers: row.additionalEngineers ?? 0,
        isUsable: row.isUsable,
        calculationMs: row.calculationMs,
        jobEnds: row.jobEnds ?? [],
        metrics: row.metrics,
      })),
      savedAt,
    };
    if (!(await tx.appState.findUnique({ where: { key } }))) {
      await tx.appState.create({
        data: { key, value: value as unknown as Prisma.InputJsonValue, updatedAt: BigInt(savedAt) },
      });
    }
    return key;
  }

  /** Writes the catalogue and the default choice if they are not there yet. */
  async ensureCatalogue(tx: Tx, now: number): Promise<void> {
    for (const policy of POLICIES) {
      await tx.policy.upsert({
        where: { policyId: policy.policyId },
        update: {
          title: policy.title,
          description: policy.description,
          isDefault: policy.isDefault,
        },
        create: {
          policyId: policy.policyId,
          title: policy.title,
          description: policy.description,
          isDefault: policy.isDefault,
          parameters: {},
        },
      });
    }
    await tx.activePolicy.upsert({
      where: { id: 'singleton' },
      // An existing choice is left alone: a restart does not undo the dispatcher's.
      update: {},
      create: {
        id: 'singleton',
        policyId: DEFAULT_POLICY_ID,
        parameters: {},
        version: 1,
        changedAt: BigInt(now),
      },
    });
  }

  list(): readonly PolicySpec[] {
    return POLICIES;
  }

  async active(tx: Tx): Promise<{
    policyId: string;
    version: number;
    changedAt: number;
    ordinaryReplanningDisabled: boolean;
  }> {
    const active = await tx.activePolicy.findUnique({ where: { id: 'singleton' } });
    return {
      policyId: active?.policyId ?? DEFAULT_POLICY_ID,
      ordinaryReplanningDisabled: await ordinaryReplanningDisabled(tx),
      version: active?.version ?? 1,
      changedAt: active ? Number(active.changedAt) : 0,
    };
  }

  /** Switching on preserves the current plan; switching off releases deferred arrivals. */
  async setOrdinaryReplanning(context: OperationContext, disabled: boolean): Promise<number> {
    await context.tx.appState.upsert({
      where: { key: ORDINARY_REPLANNING_KEY },
      create: { key: ORDINARY_REPLANNING_KEY, value: disabled, updatedAt: BigInt(context.now) },
      update: { value: disabled, updatedAt: BigInt(context.now) },
    });
    if (disabled) return 0;
    const released = await context.tx.request.updateMany({
      where: { lifecycle: 'submitted', routingDeferredUntil: { not: null } },
      data: {
        routingDeferredUntil: null,
        assignmentState: 'pending',
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    return released.count;
  }

  /** Selects a prepared policy. Only catalogue entries are accepted. */
  async select(context: OperationContext, policyId: string): Promise<{ policyId: string }> {
    const personal =
      policyId === 'personal'
        ? (await this.personal(context.tx, context.actor.accountId)).profile
        : null;
    if (!findPolicy(policyId) && !personal) {
      throw new SysError('VALIDATION_FAILED', 'Unknown policy', {
        details: { policyId, supported: POLICIES.map((policy) => policy.policyId) },
      });
    }
    if (personal)
      await context.tx.policy.upsert({
        where: { policyId: 'personal' },
        create: {
          policyId: 'personal',
          title: 'Personal',
          description: 'Account-owned objective preferences',
          isDefault: false,
          parameters: {},
        },
        update: {},
      });
    if (personal)
      await this.setOrdinaryReplanning(context, personal.preset.ordinaryReplanningDisabled);
    const parameters = personal ? { objective_order: personal.objectiveOrder.join(',') } : {};
    if (personal)
      await context.tx.appState.upsert({
        where: { key: PERSONAL_POLICY_ACTIVE_OWNER_KEY },
        create: {
          key: PERSONAL_POLICY_ACTIVE_OWNER_KEY,
          value: context.actor.accountId ?? '',
          updatedAt: BigInt(context.now),
        },
        update: { value: context.actor.accountId ?? '', updatedAt: BigInt(context.now) },
      });
    const previous = await context.tx.activePolicy.findUnique({ where: { id: 'singleton' } });
    const currentPolicyId = previous?.policyId ?? DEFAULT_POLICY_ID;
    if (currentPolicyId !== policyId) {
      const current = await context.tx.appliedPlanCurrent.findUnique({
        where: { id: 'singleton' },
        include: { plan: { include: { assignments: true } } },
      });
      const assignedIds =
        current?.plan.assignments
          .filter((assignment) => assignment.status === 'assigned')
          .map((assignment) => assignment.requestId) ?? [];
      const submitted = await context.tx.request.findMany({
        where: { id: { in: assignedIds }, lifecycle: 'submitted' },
        select: { id: true },
      });
      const runningDay = await context.tx.liveWorkday.findFirst({
        where: { status: 'running' },
        orderBy: { startedAtWallSec: 'desc' },
        select: { workDate: true, logicalEndAt: true },
      });
      const nextVersion = (previous?.version ?? 0) + 1;
      await context.tx.appState.upsert({
        where: { key: 'alerts.policy-coverage-baseline' },
        create: {
          key: 'alerts.policy-coverage-baseline',
          value: {
            requestIds: submitted.map((request) => request.id),
            policyId,
            policyVersion: nextVersion,
            operationId: context.operationId,
            workDate: runningDay?.workDate ?? null,
            expiresAt: runningDay ? Number(runningDay.logicalEndAt) : null,
          },
          updatedAt: BigInt(context.now),
        },
        update: {
          value: {
            requestIds: submitted.map((request) => request.id),
            policyId,
            policyVersion: nextVersion,
            operationId: context.operationId,
            workDate: runningDay?.workDate ?? null,
            expiresAt: runningDay ? Number(runningDay.logicalEndAt) : null,
          },
          updatedAt: BigInt(context.now),
        },
      });
    }
    await context.tx.activePolicy.upsert({
      where: { id: 'singleton' },
      update: {
        policyId,
        parameters,
        changedAt: BigInt(context.now),
        changedBy: context.actor.id,
        version: { increment: 1 },
      },
      create: {
        id: 'singleton',
        policyId,
        parameters,
        version: 1,
        changedAt: BigInt(context.now),
        changedBy: context.actor.id,
      },
    });
    await this.persistSelection(context, policyId);
    return { policyId };
  }

  private async persistSelection(context: OperationContext, policyId: string): Promise<void> {
    const selectedAt = await businessNow(context.tx, context.now);
    const publication = await context.tx.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    let inputHash: string | null = null;
    let rosterHash: string | null = null;
    let evidenceKey: string | null = null;
    if (publication) {
      inputHash = publication.snapshot.inputHash;
      let rosterEngineerIds: string[] = [];
      try {
        const payload = JSON.parse(publication.snapshot.payload) as {
          engineers?: Array<{ engineer_id?: unknown }>;
        };
        rosterEngineerIds = (payload.engineers ?? [])
          .flatMap((item) => (typeof item.engineer_id === 'string' ? [item.engineer_id] : []))
          .sort();
      } catch {
        rosterEngineerIds = [];
      }
      rosterHash = canonicalHash(rosterEngineerIds);
      const candidates = await context.tx.appState.findMany({
        where: { key: { startsWith: PERFORMANCE_POLICY_COMPARISON_PREFIX } },
        select: { key: true, value: true },
      });
      const candidate = candidates
        .map((row) => ({ key: row.key, parsed: evidenceSchema.safeParse(row.value) }))
        .filter(
          (
            row,
          ): row is {
            key: string;
            parsed: { success: true; data: z.infer<typeof evidenceSchema> };
          } => row.parsed.success,
        )
        .filter(
          (row) =>
            row.parsed.data.inputHash === inputHash && row.parsed.data.rosterHash === rosterHash,
        )
        .sort((left, right) => right.parsed.data.savedAt - left.parsed.data.savedAt)[0];
      evidenceKey = candidate?.key ?? null;
      const routerContextVersion = candidate?.parsed.data.routerContextVersion ?? null;
      const key = `${PERFORMANCE_POLICY_SELECTION_PREFIX}${context.operationId}`;
      await context.tx.appState.create({
        data: {
          key,
          value: {
            version: 1,
            policyId,
            operationId: context.operationId,
            actorKind: context.actor.kind,
            actorSource: context.actor.source,
            selectedAt,
            evidenceKey,
            inputHash,
            routerContextVersion,
            rosterHash,
          },
          updatedAt: BigInt(selectedAt),
        },
      });
      return;
    }
    const key = `${PERFORMANCE_POLICY_SELECTION_PREFIX}${context.operationId}`;
    await context.tx.appState.create({
      data: {
        key,
        value: {
          version: 1,
          policyId,
          operationId: context.operationId,
          actorKind: context.actor.kind,
          actorSource: context.actor.source,
          selectedAt,
          evidenceKey,
          inputHash,
          routerContextVersion: null,
          rosterHash,
        },
        updatedAt: BigInt(selectedAt),
      },
    });
  }
}
