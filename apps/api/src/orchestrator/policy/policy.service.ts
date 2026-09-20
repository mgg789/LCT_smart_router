import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { DEFAULT_POLICY_ID, findPolicy, POLICIES, type PolicySpec } from './policy.catalog';

/**
 * The dispatcher's choice of policy.
 *
 * Choosing one changes the data of the task and republishes it; it does not switch a
 * solver implementation and does not edit weights. A rich policy structure in the
 * contracts does not create an editor in the Dashboard (context/42 DF-15).
 */
@Injectable()
export class PolicyService {
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

  async active(tx: Tx): Promise<{ policyId: string; version: number; changedAt: number }> {
    const active = await tx.activePolicy.findUnique({ where: { id: 'singleton' } });
    return {
      policyId: active?.policyId ?? DEFAULT_POLICY_ID,
      version: active?.version ?? 1,
      changedAt: active ? Number(active.changedAt) : 0,
    };
  }

  /** Selects a prepared policy. Only catalogue entries are accepted. */
  async select(context: OperationContext, policyId: string): Promise<{ policyId: string }> {
    if (!findPolicy(policyId)) {
      throw new SysError('VALIDATION_FAILED', 'Unknown policy', {
        details: { policyId, supported: POLICIES.map((policy) => policy.policyId) },
      });
    }
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
        changedAt: BigInt(context.now),
        changedBy: context.actor.id,
        version: { increment: 1 },
      },
      create: {
        id: 'singleton',
        policyId,
        parameters: {},
        version: 1,
        changedAt: BigInt(context.now),
        changedBy: context.actor.id,
      },
    });
    return { policyId };
  }
}
