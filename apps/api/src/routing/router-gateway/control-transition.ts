import { SysError } from '../../common/errors';
import type { ControlMode } from '../../generated/prisma/client';
import { assertExpectedVersion, type OperationContext } from '../../operations';
import { lockControlState, type Tx } from '../../persistence';

/** Versions of the working state the dispatcher read; zero denotes no plan. */
export interface PlanExpectation {
  readonly expectedModeVersion: number;
  readonly expectedPlanRevision: number;
}

/** Checks both versions under the same lock used by automatic result acceptance. */
export async function assertPlanExpectation(tx: Tx, expected: PlanExpectation): Promise<void> {
  await lockControlState(tx);
  const state = await tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
  const pointer = await tx.appliedPlanCurrent.findUnique({
    where: { id: 'singleton' },
    include: { plan: true },
  });
  assertExpectedVersion('Control mode', expected.expectedModeVersion, state.modeVersion);
  assertExpectedVersion('Applied plan', expected.expectedPlanRevision, pointer?.plan.revision ?? 0);
}

/**
 * The common transition for dashboard and alert actions. State and evidence commit
 * together; alert actions already hold the control lock and validate their own context.
 */
export async function transitionControl(
  context: OperationContext,
  mode: ControlMode,
  reason?: string,
  expected?: PlanExpectation,
) {
  const trimmed = reason?.trim();
  if (mode === 'manual' && (!trimmed || trimmed.length > 2000)) {
    throw new SysError('VALIDATION_FAILED', 'Entering manual control requires a nonblank reason');
  }
  await lockControlState(context.tx);
  if (expected) await assertPlanExpectation(context.tx, expected);
  const previous = await context.tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
  if (previous.mode === mode) return previous;
  const pointer = await context.tx.appliedPlanCurrent.findUnique({
    where: { id: 'singleton' },
    include: { plan: true },
  });
  const updated = await context.tx.controlState.update({
    where: { id: 'singleton' },
    data: {
      mode,
      modeVersion: { increment: 1 },
      changedAt: BigInt(context.now),
      changedBy: context.actor.id,
      frozenPlanId: mode === 'manual' ? (pointer?.planId ?? null) : null,
    },
  });
  await context.tx.auditLog.create({
    data: {
      at: BigInt(context.businessTime ? Math.floor(Date.now() / 1000) : context.now),
      actorKind: context.actor.kind,
      actorId: context.actor.id,
      source: context.actor.source,
      operationId: context.operationId,
      action: 'control.transition',
      targetRef: pointer?.planId ?? null,
      details: {
        from: previous.mode,
        to: mode,
        reason: trimmed ?? null,
        sourcePlanRevision: pointer?.plan.revision ?? null,
        modeVersion: updated.modeVersion,
      },
    },
  });
  return updated;
}
