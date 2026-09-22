import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { Request } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { workDateOf } from '../../orchestrator/engineers/workday';
import { businessNow } from '../../orchestrator/live/business-clock';
import { lockRoutingCurrent } from '../../persistence';
import { AppliedPlanService } from './applied-plan.service';
import { ControlStateService } from './control-state.service';
import { assertPlanExpectation, type PlanExpectation } from './control-transition';

/** One explicit dispatcher gesture, not an optimisation request. */
export type ManualChange =
  | { kind: 'reassign'; requestId: string; engineerId: string }
  | { kind: 'reorder'; requestIds: string[]; engineerId: string };

/** Checkable constraints; timing checks use a lower bound without invented road time. */
export interface ManualWarning {
  readonly code: string;
  readonly requestId: string;
  readonly engineerId: string;
}

/** Atomic, versioned dispatcher edits. Router is never required for these operations. */
@Injectable()
export class ManualPlanService {
  constructor(
    private readonly plans: AppliedPlanService,
    private readonly control: ControlStateService,
  ) {}

  /** Read-only preview using the same admission checks as the eventual write. */
  async preview(context: OperationContext, change: ManualChange, expected: PlanExpectation) {
    const prepared = await this.prepare(context, change, expected);
    return {
      sourcePlanRevision: prepared.current.revision,
      queues: prepared.queues,
      warnings: prepared.warnings,
      timingStatus: 'unverified' as const,
    };
  }

  /** Moves unstarted work to the end of the chosen engineer's queue. */
  async reassign(
    context: OperationContext,
    requestId: string,
    engineerId: string,
    expected: PlanExpectation,
  ) {
    return this.apply(context, { kind: 'reassign', requestId, engineerId }, expected);
  }

  /** Reorders all editable jobs; execution and non-job stops retain their slots. */
  async reorder(
    context: OperationContext,
    engineerId: string,
    requestIds: string[],
    expected: PlanExpectation,
  ) {
    return this.apply(context, { kind: 'reorder', requestIds, engineerId }, expected);
  }

  private async prepare(
    context: OperationContext,
    change: ManualChange,
    expected: PlanExpectation,
  ) {
    await assertPlanExpectation(context.tx, expected);
    await lockRoutingCurrent(context.tx);
    await this.control.assertManual(context.tx);
    // Revision zero is the absence of a first plan. Manual admission can build a
    // working queue from submitted requests even if Router has never been available.
    const current = (await this.plans.current(context.tx)) ?? {
      revision: 0,
      planAsOf: BigInt(await businessNow(context.tx, context.now)),
      routes: [],
    };
    const targetEngineer = await context.tx.engineer.findUnique({
      where: { id: change.engineerId },
    });
    if (!targetEngineer || targetEngineer.archivedAt !== null)
      throw SysError.validationFailed('The target engineer is unavailable');
    if (
      !current.routes.some((route) => route.engineerId === change.engineerId) &&
      (targetEngineer.homeLat === null || targetEngineer.homeLon === null)
    )
      throw SysError.validationFailed('The engineer needs a confirmed start point');
    const ids = current.routes.flatMap((r) =>
      r.stops.flatMap((s) => (s.requestId ? [s.requestId] : [])),
    );
    if (change.kind === 'reassign') ids.push(change.requestId);
    const requests = await context.tx.request.findMany({ where: { id: { in: ids } } });
    const byId = new Map(requests.map((r) => [r.id, r]));
    const inferredCompleted = new Set(
      (
        await context.tx.liveRequestState.findMany({
          where: { requestId: { in: ids }, assumedCompletedAt: { not: null } },
          select: { requestId: true },
        })
      ).map((row) => row.requestId),
    );
    const editableRequest = (id: string) => isEditable(byId.get(id)) && !inferredCompleted.has(id);
    const queues = current.routes.map((route) => ({
      engineerId: route.engineerId,
      requestIds: route.stops.flatMap((s) => (s.requestId ? [s.requestId] : [])),
    }));
    const changedIds: string[] = [];
    if (change.kind === 'reassign') {
      const request = byId.get(change.requestId);
      if (!request) throw SysError.notFound('Request');
      if (!editableRequest(request.id))
        throw new SysError('WORK_ALREADY_STARTED', 'Only unstarted submitted work may move');
      if (request.lat === null || request.lon === null)
        throw SysError.validationFailed('The request needs a confirmed map point');
      changedIds.push(request.id);
      for (const queue of queues)
        queue.requestIds = queue.requestIds.filter((id) => id !== request.id);
      let target = queues.find((q) => q.engineerId === change.engineerId);
      if (!target) {
        target = { engineerId: change.engineerId, requestIds: [] };
        queues.push(target);
      }
      target.requestIds.push(request.id);
    } else {
      const target = queues.find((q) => q.engineerId === change.engineerId);
      if (!target) throw SysError.notFound('Engineer route');
      const editable = target.requestIds.filter(editableRequest);
      if (
        new Set(change.requestIds).size !== editable.length ||
        change.requestIds.length !== editable.length ||
        change.requestIds.some((id) => !editable.includes(id))
      ) {
        throw SysError.validationFailed(
          'Supply each unstarted job exactly once; protected jobs cannot move',
          {
            editableRequestIds: editable,
          },
        );
      }
      let index = 0;
      target.requestIds = target.requestIds.map((id) =>
        editableRequest(id) ? requireValue(change.requestIds[index++], 'Request order') : id,
      );
      changedIds.push(...editable);
    }
    const warnings = await this.warnings(
      context,
      queues,
      byId,
      current.planAsOf,
      inferredCompleted,
    );
    return { current, byId, queues, changedIds, warnings };
  }

  private async apply(context: OperationContext, change: ManualChange, expected: PlanExpectation) {
    const { current, byId, queues, changedIds, warnings } = await this.prepare(
      context,
      change,
      expected,
    );
    for (const id of changedIds) {
      const request = requireValue(byId.get(id), 'Request');
      const changed = await context.tx.request.updateMany({
        where: { id, version: request.version, lifecycle: 'submitted', startedAt: null },
        data: {
          assignmentState: 'assigned',
          version: { increment: 1 },
          updatedAt: BigInt(context.now),
        },
      });
      if (changed.count !== 1)
        throw SysError.versionConflict('Request', request.version, request.version + 1);
    }
    const revision = await this.plans.beginManualRevision(
      context.tx,
      context.now,
      context.actor.id,
      change.kind === 'reassign'
        ? `reassign ${change.requestId} to ${change.engineerId}`
        : `reorder queue of ${change.engineerId}`,
      await businessNow(
        context.tx,
        context.now,
        workDateOf(Number(current.planAsOf), 'Europe/Moscow'),
      ),
    );
    const routes = await context.tx.appliedPlanRoute.findMany({
      where: { planId: revision.id },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });
    if (change.kind === 'reassign') {
      const request = requireValue(byId.get(change.requestId), 'Request');
      const previousStop = routes.flatMap((r) => r.stops).find((s) => s.requestId === request.id);
      await context.tx.appliedPlanStop.deleteMany({
        where: { requestId: request.id, route: { planId: revision.id } },
      });
      let target = routes.find((r) => r.engineerId === change.engineerId);
      if (!target) {
        const engineer = await context.tx.engineer.findUniqueOrThrow({
          where: { id: change.engineerId },
        });
        if (engineer.homeLat === null || engineer.homeLon === null)
          throw SysError.validationFailed('The engineer needs a confirmed start point');
        target = await context.tx.appliedPlanRoute.create({
          data: {
            planId: revision.id,
            engineerId: engineer.id,
            startLat: engineer.homeLat,
            startLon: engineer.homeLon,
            lunchStatus: 'not_scheduled',
            reasons: [],
          },
          include: { stops: true },
        });
      }
      await context.tx.appliedPlanStop.create({
        data: {
          routeId: target.id,
          sequence: Math.max(-1, ...target.stops.map((s) => s.sequence)) + 1,
          kind: 'job',
          requestId: request.id,
          lat: requireValue(request.lat, 'Request latitude'),
          lon: requireValue(request.lon, 'Request longitude'),
          // Archival schedule only. Manual origin marks it unverified for every consumer.
          arrivalAt: previousStop?.arrivalAt ?? request.windowStartAt,
          startAt: previousStop?.startAt ?? request.windowStartAt,
          endAt: previousStop?.endAt ?? request.windowStartAt + BigInt(request.serviceDurationSec),
        },
      });
      const reasons = [
        {
          code: 'MANUAL_ASSIGNMENT',
          basis: 'dispatcher',
          facts: { operationId: context.operationId, sourcePlanRevision: current.revision },
          text: 'Assigned by dispatcher; schedule requires review',
        },
      ];
      await context.tx.appliedPlanAssignment.upsert({
        where: { planId_requestId: { planId: revision.id, requestId: request.id } },
        update: { status: 'assigned', engineerId: change.engineerId, stopId: null, reasons },
        create: {
          planId: revision.id,
          requestId: request.id,
          status: 'assigned',
          engineerId: change.engineerId,
          reasons,
        },
      });
    } else {
      const route = requireValue(
        routes.find((r) => r.engineerId === change.engineerId),
        'Engineer route',
      );
      const movable = route.stops.filter((s) => s.requestId && changedIds.includes(s.requestId));
      const offset = Math.max(-1, ...route.stops.map((s) => s.sequence)) + route.stops.length + 1;
      for (const stop of movable)
        await context.tx.appliedPlanStop.update({
          where: { id: stop.id },
          data: { sequence: stop.sequence + offset },
        });
      for (const [index, id] of change.requestIds.entries()) {
        const stop = requireValue(
          movable.find((s) => s.requestId === id),
          'Request stop',
        );
        await context.tx.appliedPlanStop.update({
          where: { id: stop.id },
          data: { sequence: requireValue(movable[index], 'Queue slot').sequence },
        });
      }
    }
    // An explicit ETA is a future reservation, not execution. A manual edit releases
    // it so the old engineer cannot start a request that has just been reassigned.
    await context.tx.liveRequestState.updateMany({
      where: {
        requestId: { in: changedIds },
        assumedCompletedAt: null,
        workday: { status: 'running' },
      },
      data: {
        reservedEngineerId: null,
        reportedEtaAt: null,
        assumedStartedAt: null,
        replanPendingEngineerId: null,
        replanPendingPlanRevision: null,
        replanRequestedAt: null,
        version: { increment: 1 },
        updatedAt: BigInt(context.now),
      },
    });
    // Roads belong to the old order. The UI must show current points and the manual
    // sequence; retained numerical schedules are explicitly unverified archival data.
    for (const queue of queues)
      await context.tx.appliedPlanRoute.updateMany({
        where: { planId: revision.id, engineerId: queue.engineerId },
        data: {
          legs: [],
          assignedCount: queue.requestIds.length,
          reasons: [
            {
              code: 'MANUAL_SCHEDULE_UNVERIFIED',
              basis: 'dispatcher',
              facts: {},
              text: 'Timing not recalculated',
            },
          ],
        },
      });
    await this.plans.publishRevision(context.tx, context.now, revision.id);
    await context.tx.auditLog.create({
      data: {
        at: BigInt(context.now),
        actorKind: context.actor.kind,
        actorId: context.actor.id,
        source: context.actor.source,
        operationId: context.operationId,
        action: 'plan.manual',
        targetRef: revision.id,
        details: {
          change,
          sourcePlanRevision: current.revision,
          planRevision: revision.revision,
          before: current.routes.map((r) => ({
            engineerId: r.engineerId,
            requestIds: r.stops.flatMap((s) => (s.requestId ? [s.requestId] : [])),
          })),
          after: queues,
          warnings: warnings.map((warning) => ({ ...warning })),
        },
      },
    });
    return { planRevision: revision.revision, warnings, timingStatus: 'unverified' as const };
  }

  private async warnings(
    context: OperationContext,
    queues: Array<{ engineerId: string; requestIds: string[] }>,
    requests: Map<string, Request>,
    planAsOf: bigint,
    inferredCompleted: ReadonlySet<string>,
  ): Promise<ManualWarning[]> {
    const warnings: ManualWarning[] = [];
    const now = await businessNow(context.tx, context.now);
    const workDate = workDateOf(Number(planAsOf), 'Europe/Moscow');
    for (const queue of queues) {
      const engineer = await context.tx.engineer.findUnique({
        where: { id: queue.engineerId },
        include: { days: { where: { workDate } } },
      });
      if (!engineer) {
        warnings.push(
          ...queue.requestIds.map((requestId) => ({
            code: 'ENGINEER_UNAVAILABLE',
            requestId,
            engineerId: queue.engineerId,
          })),
        );
        continue;
      }
      const day = engineer.days[0];
      let earliest = Math.max(now, Number(day?.shiftStartAt ?? 0));
      for (const id of queue.requestIds) {
        const request = requests.get(id);
        if (!request) continue;
        if (inferredCompleted.has(id)) continue;
        if (!isEditable(request)) {
          earliest = Math.max(
            earliest,
            Number(request.completedAt ?? request.continuationAvailableAt ?? 0),
          );
          continue;
        }
        const warn = (code: string) =>
          warnings.push({ code, requestId: id, engineerId: queue.engineerId });
        if (!engineer.skills.includes(request.requiredSkill)) warn('SKILL_MISMATCH');
        if (request.requiredTransport && request.requiredTransport !== engineer.transportType)
          warn('TRANSPORT_MISMATCH');
        if (request.region && engineer.region && request.region !== engineer.region)
          warn('REGION_MISMATCH');
        if (day?.availability !== 'online' || engineer.archivedAt !== null)
          warn('ENGINEER_UNAVAILABLE');
        earliest = Math.max(earliest, Number(request.windowStartAt));
        if (earliest > Number(request.windowEndAt)) warn('WINDOW_CONFLICT');
        earliest += request.serviceDurationSec;
        if (!day || earliest > Number(day.shiftEndAt)) warn('SHIFT_CONFLICT');
        warn('TIMING_UNVERIFIED');
      }
    }
    return warnings;
  }
}

function isEditable(request: Request | undefined): boolean {
  return (
    request?.lifecycle === 'submitted' &&
    request.startedAt === null &&
    request.completedAt === null &&
    request.cancelledAt === null
  );
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw SysError.notFound(label);
  return value;
}
