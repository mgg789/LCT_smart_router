import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { FactKind, Request } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { AppliedPlanService } from '../../routing/router-gateway/applied-plan.service';

export type ReportableFact = 'arrived' | 'arrived_blocked' | 'started' | 'finished' | 'problem';

/**
 * Confirmed execution facts.
 *
 * Every fact here comes from an explicit mark by the engineer. Nothing creates one from a
 * timer, from GPS, from a schedule or from silence: a computed duration does not close a
 * request and does not make anyone free (context/32 sections 5.3 and 5.4).
 *
 * Arrival and start stay separate events. They can be reported together in the ordinary
 * case, but an engineer who is on site and cannot begin must be able to say exactly that,
 * so `arrived_blocked` exists and creates no `in_progress` (context/42 DF-07).
 */
@Injectable()
export class FactsService {
  constructor(private readonly plans: AppliedPlanService) {}

  async record(
    context: OperationContext,
    engineerId: string,
    requestId: string,
    kind: ReportableFact,
    occurredAt: number,
    note: string | null,
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
        return this.finish(context, engineerId, request, occurredAt, note);

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

    await this.write(context, engineerId, request.id, 'started', occurredAt, note);
    await context.tx.request.update({
      where: { id: request.id },
      data: {
        lifecycle: 'in_progress',
        // From here the customer's ordinary changes are closed, through every path
        // (context/42 DF-05).
        startedAt: BigInt(occurredAt),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    return this.reload(context.tx, request.id);
  }

  private async finish(
    context: OperationContext,
    engineerId: string,
    request: Request,
    occurredAt: number,
    note: string | null,
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

    await this.write(context, engineerId, request.id, 'finished', occurredAt, note);
    await context.tx.request.update({
      where: { id: request.id },
      data: {
        lifecycle: 'completed',
        completedAt: BigInt(occurredAt),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    // No snapshot is published for a routine completion. Following the plan needs no
    // re-optimisation; the fact travels in the next justified projection
    // (context/42 DF-07).
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
  }

  private async reload(tx: Tx, requestId: string): Promise<Request> {
    return tx.request.findUniqueOrThrow({ where: { id: requestId } });
  }
}
