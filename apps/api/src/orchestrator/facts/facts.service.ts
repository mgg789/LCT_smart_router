import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { FactKind, Request } from '../../generated/prisma/client';
import { NotificationsService } from '../../notifications';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { AppliedPlanService } from '../../routing/router-gateway/applied-plan.service';
import { ExecutionTimingPolicy, type ExecutionTimingPolicyValue } from './execution-timing-policy';

export type ReportableFact = 'arrived' | 'arrived_blocked' | 'started' | 'finished' | 'problem';

/**
 * Confirmed execution facts.
 *
 * Every fact here comes from an explicit mark by the engineer. Nothing creates one from a
 * timer, from GPS, from a schedule or from silence: a computed duration never closes a
 * request. Crossing an overrun threshold may only withdraw future capacity until an
 * explicit finish arrives.
 *
 * Arrival and start stay separate events. They can be reported together in the ordinary
 * case, but an engineer who is on site and cannot begin must be able to say exactly that,
 * so `arrived_blocked` exists and creates no `in_progress` (context/42 DF-07).
 */
@Injectable()
export class FactsService {
  constructor(
    private readonly plans: AppliedPlanService,
    private readonly publisher: SnapshotPublisher,
    private readonly timingPolicy: ExecutionTimingPolicy,
    private readonly notifications: NotificationsService,
  ) {}

  /** Reads the Router-owned variance thresholds before opening a database transaction. */
  timing(): Promise<ExecutionTimingPolicyValue> {
    return this.timingPolicy.read();
  }

  async record(
    context: OperationContext,
    engineerId: string,
    requestId: string,
    kind: ReportableFact,
    occurredAt: number,
    note: string | null,
    timing: ExecutionTimingPolicyValue,
  ): Promise<Request> {
    const request = await this.assertAssigned(context.tx, engineerId, requestId);

    switch (kind) {
      case 'arrived':
      case 'arrived_blocked':
        // Arrival is recorded and the work stays not started. Being on site is not
        // performing the work.
        await this.write(context, engineerId, requestId, kind, occurredAt, note);
        return this.reload(context.tx, requestId);

      case 'started':
        return this.start(context, engineerId, request, occurredAt, note);

      case 'finished':
        return this.finish(context, engineerId, request, occurredAt, note, timing);

      case 'problem':
        // A reported problem is recorded as a fact and changes no stage by itself. What it
        // means for the plan is for sys to establish, and a delay is never invented from
        // the text of a message (context/36 section 5.3).
        await this.write(context, engineerId, requestId, 'problem', occurredAt, note);
        return this.reload(context.tx, requestId);

      default:
        throw new SysError('VALIDATION_FAILED', 'Unknown fact');
    }
  }

  private async start(
    context: OperationContext,
    engineerId: string,
    request: Request,
    occurredAt: number,
    note: string | null,
  ): Promise<Request> {
    if (request.lifecycle === 'in_progress') {
      // Repeating the mark is not a second start.
      return request;
    }
    if (request.lifecycle !== 'submitted') {
      throw new SysError('VALIDATION_FAILED', 'This work cannot be started', {
        details: { lifecycle: request.lifecycle },
      });
    }
    const otherActive = await context.tx.requestFact.findFirst({
      where: {
        engineerId,
        kind: 'started',
        requestId: { not: request.id },
        request: { lifecycle: 'in_progress' },
      },
      select: { requestId: true },
    });
    if (otherActive) {
      throw new SysError('VALIDATION_FAILED', 'Engineer already has work in progress', {
        details: { engineerId, activeRequestId: otherActive.requestId },
      });
    }

    await this.write(context, engineerId, request.id, 'started', occurredAt, note);
    await context.tx.request.update({
      where: { id: request.id },
      data: {
        lifecycle: 'in_progress',
        // From here the customer's ordinary changes are closed, through every path
        // (context/42 DF-05).
        startedAt: BigInt(occurredAt),
        expectedCompletionAt: BigInt(occurredAt + request.serviceDurationSec),
        continuationAvailableAt: BigInt(occurredAt + request.serviceDurationSec),
        overrunDetectedAt: null,
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });

    // The engineer's own start mark is the confirmation the customer waits for after the
    // assignment letter (card #65, 2026-09-20 decision). One letter per started request.
    await this.notifications.record(context.tx, context.now, {
      category: 'engineer_confirmed',
      businessEventKey: `engineer_confirmed:${request.id}`,
      recipientAccountId: request.clientAccountId,
      payload: { requestId: request.id, engineerId },
    });
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.REQUEST_EXECUTION_STARTED,
    );
    return this.reload(context.tx, request.id);
  }

  private async finish(
    context: OperationContext,
    engineerId: string,
    request: Request,
    occurredAt: number,
    note: string | null,
    timing: ExecutionTimingPolicyValue,
  ): Promise<Request> {
    if (request.lifecycle === 'completed') {
      return request;
    }
    if (request.lifecycle !== 'in_progress') {
      // Completion of work that never started would be a fabricated history, so it is
      // refused rather than inferred (context/38: the timer reaching zero proves nothing).
      throw new SysError('VALIDATION_FAILED', 'This work has not been started', {
        details: { lifecycle: request.lifecycle },
      });
    }
    if (request.startedAt === null) {
      throw new SysError('VALIDATION_FAILED', 'Started work has no start timestamp', {
        details: { requestId: request.id },
      });
    }
    const startedAt = Number(request.startedAt);
    if (occurredAt < startedAt) {
      throw new SysError('VALIDATION_FAILED', 'Finish time cannot precede start time', {
        details: { requestId: request.id, startedAt, completedAt: occurredAt },
      });
    }

    const actualDurationSec = occurredAt - startedAt;
    const expectedCompletionAt =
      request.expectedCompletionAt === null
        ? startedAt + request.serviceDurationSec
        : Number(request.expectedCompletionAt);
    const earlyGainSec = request.serviceDurationSec - actualDurationSec;
    const overrunSec = actualDurationSec - request.serviceDurationSec;
    const materialEarly = earlyGainSec >= timing.earlyFinishReplanThresholdSec;
    const materialLate = overrunSec > timing.taskOverrunToleranceSec;
    const materialVariance = materialEarly || materialLate || request.overrunDetectedAt !== null;

    await this.write(context, engineerId, request.id, 'finished', occurredAt, note);
    await context.tx.request.update({
      where: { id: request.id },
      data: {
        lifecycle: 'completed',
        completedAt: BigInt(occurredAt),
        // Small deviations are deliberately absorbed by the existing route. Material
        // variance releases the route from the confirmed finish at the task location.
        continuationAvailableAt: BigInt(materialVariance ? occurredAt : expectedCompletionAt),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    if (materialVariance) {
      await this.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.REQUEST_EXECUTION_VARIANCE,
      );
    }

    // The confirmed finish closes the loop the request-received letter opened (card #65,
    // 2026-09-20 decision). One letter per completed request, regardless of variance.
    await this.notifications.record(context.tx, context.now, {
      category: 'request_completed',
      businessEventKey: `request_completed:${request.id}`,
      recipientAccountId: request.clientAccountId,
      payload: { requestId: request.id, engineerId, completedAt: occurredAt },
    });

    return this.reload(context.tx, request.id);
  }

  /**
   * An engineer may only mark work the applied plan gave them.
   *
   * The plan is the authority, not the request row: what someone may report is what they
   * were actually assigned.
   */
  private async assertAssigned(tx: Tx, engineerId: string, requestId: string): Promise<Request> {
    const request = await tx.request.findUnique({ where: { id: requestId } });
    if (!request) {
      throw SysError.notFound('Request', { requestId });
    }

    // Once work starts, its ownership comes from the confirmed start fact. A replan
    // intentionally removes that request from the free pool and therefore from the new
    // applied plan; the same engineer must still be allowed to finish or report a problem.
    if (request.startedAt !== null) {
      const start = await tx.requestFact.findFirst({
        where: { requestId, kind: 'started' },
        orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }],
      });
      if (start?.engineerId === engineerId) {
        return request;
      }
    }

    const plan = await this.plans.current(tx);
    if (!plan) {
      throw new SysError('NOT_FOUND', 'There is no working plan yet', { details: { requestId } });
    }
    const assignment = plan.assignments.find((item) => item.requestId === requestId);
    if (assignment?.status !== 'assigned' || assignment.engineerId !== engineerId) {
      throw SysError.forbidden('This work is not in your plan', { requestId });
    }
    return request;
  }

  private async write(
    context: OperationContext,
    engineerId: string,
    requestId: string,
    kind: FactKind,
    occurredAt: number,
    note: string | null,
  ): Promise<void> {
    await context.tx.requestFact.create({
      data: {
        requestId,
        engineerId,
        kind,
        // When the engineer says it happened.
        occurredAt: BigInt(occurredAt),
        // When sys stored it. The two are kept apart and neither substitutes for the other.
        recordedAt: BigInt(context.now),
        note,
        operationId: context.operationId,
      },
    });
    // A fact submitted by the engineer is also a confirmed app activity. It is not
    // inferred from a route timestamp, and it only touches the day containing the fact.
    await context.tx.engineerDay.updateMany({
      where: {
        engineerId,
        shiftStartAt: { lte: BigInt(occurredAt) },
        shiftEndAt: { gte: BigInt(occurredAt) },
      },
      data: {
        lastAttendanceAt: BigInt(context.now),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
  }

  private async reload(tx: Tx, requestId: string): Promise<Request> {
    return tx.request.findUniqueOrThrow({ where: { id: requestId } });
  }
}
