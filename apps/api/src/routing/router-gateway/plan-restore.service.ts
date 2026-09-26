import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { OperationContext } from '../../operations';
import { AlertsService } from '../../orchestrator/alerts';
import { businessNow } from '../../orchestrator/live/business-clock';
import type { RouterTaskSnapshot } from '../mount-data-eng';
import { AppliedPlanService } from './applied-plan.service';
import { ResultAcceptanceService } from './result-acceptance.service';

const CONTEXT_MUTATION_ACTIONS = [
  'router.technical-settings.replace',
  'router.road_import',
] as const;

/**
 * Durable boundary around Router's external context read.  The operation journal is
 * sampled before that read and compared again under the plan lock, so an in-flight
 * context mutation cannot slip between the two without being noticed.
 */
export interface RouterContextMutationFence {
  readonly operations: ReadonlyArray<{
    readonly operationId: string;
    readonly state: string;
  }>;
}

/** Restores the immediate predecessor as a new revision after checking current reality. */
@Injectable()
export class PlanRestoreService {
  constructor(
    private readonly plans: AppliedPlanService,
    private readonly acceptance: ResultAcceptanceService,
    private readonly alerts: AlertsService,
  ) {}

  async previous(
    context: { readonly tx: import('../../persistence').Tx; readonly now: number },
    activeContextVersion: string | null,
  ) {
    const current = await this.plans.current(context.tx);
    if (!current)
      return {
        current: null,
        previous: null,
        eligibility: { eligible: false, reason: 'NO_CURRENT_PLAN' },
      };
    const previous = await this.plans.previous(context.tx, current.revision);
    if (!previous)
      return {
        current,
        previous: null,
        eligibility: { eligible: false, reason: 'NO_PREVIOUS_PLAN' },
      };
    return {
      current,
      previous,
      eligibility: await this.eligibility(
        context.tx,
        await businessNow(context.tx, context.now),
        current,
        previous,
        activeContextVersion,
      ),
    };
  }

  async restore(
    context: OperationContext,
    expectedRevision: number,
    activeContextVersion: string | null,
    contextFence: RouterContextMutationFence,
  ) {
    const fence = await this.contextMutationFence(context.tx);
    if (fence.operations.some((operation) => operation.state === 'outcome_unknown'))
      throw new SysError('RESULT_NOT_APPLICABLE', 'Router context mutation is still in progress', {
        details: { reason: 'ROUTER_CONTEXT_MUTATION_PENDING' },
      });
    if (!sameContextMutationFence(contextFence, fence))
      throw new SysError(
        'RESULT_NOT_APPLICABLE',
        'Router context changed while restore was starting',
        {
          details: { reason: 'ROUTER_CONTEXT_CHANGED' },
        },
      );
    const current = await this.plans.current(context.tx);
    if (!current) throw SysError.notFound('Applied plan');
    if (current.revision !== expectedRevision)
      throw SysError.versionConflict('Applied plan', expectedRevision, current.revision);
    const previous = await this.plans.previous(context.tx, current.revision);
    if (!previous) throw SysError.validationFailed('There is no previous plan revision to restore');
    const eligibility = await this.eligibility(
      context.tx,
      await businessNow(context.tx, context.now),
      current,
      previous,
      activeContextVersion,
    );
    if (!eligibility.eligible)
      throw new SysError(
        'RESULT_NOT_APPLICABLE',
        'The previous plan is no longer safe to restore',
        { details: { reason: eligibility.reason } },
      );
    if (await context.tx.equipmentHandoff.count({ where: { completedAt: null } }))
      throw SysError.validationFailed(
        'Complete accepted equipment meetings before restoring a previous plan',
      );
    const restored = await this.plans.restoreRevision(
      context.tx,
      context.now,
      previous,
      context.actor.id,
    );
    await this.plans.restoreHandoffs(context.tx, context.now, previous);
    await this.plans.publishRevision(context.tx, context.now, restored.id);
    for (const assignment of previous.assignments) {
      await context.tx.request.updateMany({
        where: { id: assignment.requestId, lifecycle: 'submitted', startedAt: null },
        data: {
          assignmentState: assignment.status,
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
    }
    await this.alerts.invalidateOtherRouterConditions(
      context.tx,
      context.now,
      previous.routerResult?.resultId ?? null,
    );
    await this.alerts.recordPlanRebuilt(
      context.tx,
      context.now,
      previous.routerResult?.resultId ?? null,
    );
    return {
      fromRevision: previous.revision,
      restoredRevision: restored.revision,
      origin: 'restore' as const,
    };
  }

  private async eligibility(
    tx: import('../../persistence').Tx,
    now: number,
    current: NonNullable<Awaited<ReturnType<AppliedPlanService['current']>>>,
    previous: NonNullable<Awaited<ReturnType<AppliedPlanService['previous']>>>,
    activeContextVersion: string | null,
  ): Promise<{ eligible: boolean; reason: string | null }> {
    if (previous.routes.some((route) => route.stops.some((stop) => Number(stop.startAt) < now)))
      return { eligible: false, reason: 'SCHEDULE_IN_THE_PAST' };
    const currentRequests = [...current.assignments.map((item) => item.requestId)].sort();
    const previousRequests = [...previous.assignments.map((item) => item.requestId)].sort();
    if (JSON.stringify(currentRequests) !== JSON.stringify(previousRequests))
      return { eligible: false, reason: 'REQUEST_SET_CHANGED' };
    if (
      current.routerResult?.routerContextVersion &&
      previous.routerResult?.routerContextVersion &&
      current.routerResult.routerContextVersion !== previous.routerResult.routerContextVersion
    )
      return { eligible: false, reason: 'ROUTER_CONTEXT_CHANGED' };
    if (!activeContextVersion) return { eligible: false, reason: 'ROUTER_CONTEXT_UNAVAILABLE' };
    if (previous.routerResult?.routerContextVersion !== activeContextVersion)
      return { eligible: false, reason: 'ROUTER_CONTEXT_CHANGED' };
    const facts = await this.acceptance.conflictWithStoredPlanFacts(tx, previous);
    if (facts) return { eligible: false, reason: 'EXECUTION_FACTS_CHANGED' };
    const currentSnapshot = await tx.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    const sourceSnapshot = previous.routerResult
      ? await tx.routingSnapshot.findFirst({
          where: { inputHash: previous.routerResult.inputHash },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    if (!currentSnapshot || !sourceSnapshot)
      return { eligible: false, reason: 'SNAPSHOT_UNAVAILABLE' };
    const currentTask = JSON.parse(currentSnapshot.snapshot.payload) as RouterTaskSnapshot;
    const sourceTask = JSON.parse(sourceSnapshot.payload) as RouterTaskSnapshot;
    const engineerIds = new Set([
      ...current.routes.map((route) => route.engineerId),
      ...previous.routes.map((route) => route.engineerId),
    ]);
    if (
      currentTask.horizon_start_at !== sourceTask.horizon_start_at ||
      currentTask.horizon_end_at !== sourceTask.horizon_end_at ||
      !sameCollectionById(currentTask.requests, sourceTask.requests, 'request_id') ||
      !sameById(currentTask.engineers, sourceTask.engineers, engineerIds, 'engineer_id')
    )
      return { eligible: false, reason: 'INPUT_CONDITIONS_CHANGED' };
    const equipmentRequests = await tx.request.findMany({
      where: { id: { in: previousRequests }, requiredEquipment: { not: null } },
      select: { id: true },
    });
    const equipmentIds = new Set(equipmentRequests.map((request) => request.id));
    const currentByRequest = new Map(
      current.assignments.map((item) => [item.requestId, item.engineerId]),
    );
    const previousByRequest = new Map(
      previous.assignments.map((item) => [item.requestId, item.engineerId]),
    );
    if (
      [...equipmentIds].some((id) => currentByRequest.get(id) !== previousByRequest.get(id)) &&
      (await tx.engineerDay.count({
        where: { engineerId: { in: [...engineerIds] }, equipmentIssuedAt: { not: null } },
      })) > 0
    )
      return { eligible: false, reason: 'EQUIPMENT_ISSUED_ASSIGNMENT_CHANGED' };
    return { eligible: true, reason: null };
  }

  /** Reads only durable mutations which can change Router's versioned context. */
  async contextMutationFence(
    tx: Pick<import('../../persistence').Tx, 'operation'>,
  ): Promise<RouterContextMutationFence> {
    const operations = await tx.operation.findMany({
      where: { action: { in: [...CONTEXT_MUTATION_ACTIONS] } },
      select: { operationId: true, state: true },
      orderBy: { operationId: 'asc' },
    });
    return {
      operations: operations.map((operation) => ({
        operationId: operation.operationId,
        state: operation.state,
      })),
    };
  }
}

function sameById<T extends Record<K, string>, K extends string>(
  current: readonly T[],
  source: readonly T[],
  ids: ReadonlySet<string>,
  key: K,
): boolean {
  const currentById = new Map(current.map((item) => [String(item[key]), item]));
  const sourceById = new Map(source.map((item) => [String(item[key]), item]));
  for (const id of ids) {
    if (JSON.stringify(currentById.get(id)) !== JSON.stringify(sourceById.get(id))) return false;
  }
  return true;
}

/** The request snapshot is complete: additions and removals are both material changes. */
function sameCollectionById<T extends Record<K, string>, K extends string>(
  current: readonly T[],
  source: readonly T[],
  key: K,
): boolean {
  if (current.length !== source.length) return false;
  return sameById(current, source, new Set(source.map((item) => String(item[key]))), key);
}

function sameContextMutationFence(
  expected: RouterContextMutationFence,
  actual: RouterContextMutationFence,
): boolean {
  return JSON.stringify(expected.operations) === JSON.stringify(actual.operations);
}
