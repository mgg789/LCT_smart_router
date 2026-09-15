import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { AppliedPlanService } from './applied-plan.service';
import { ControlStateService } from './control-state.service';

/**
 * The dispatcher's own edits while manual control is on.
 *
 * Exactly two gestures, as decided in context/39 DB5: move a request to another engineer,
 * and reorder one engineer's queue. There is deliberately no group draft and no "apply
 * changes" button -- a completed gesture is saved through sys immediately, and an
 * intermediate cursor movement is not a write.
 *
 * Neither gesture requires an ETA. Old automatic times and travel figures are not
 * recomputed and not presented as if they had been: sys runs no hidden optimiser of its
 * own (context/42 DF-14).
 */
@Injectable()
export class ManualPlanService {
  constructor(
    private readonly plans: AppliedPlanService,
    private readonly control: ControlStateService,
  ) {}

  /**
   * Moves work that has not started to another engineer.
   *
   * One atomic change: the request leaves the old queue and joins the new one, with no
   * moment in which two engineers hold it (context/39 DB5).
   */
  async reassign(
    context: OperationContext,
    requestId: string,
    toEngineerId: string,
  ): Promise<{ planRevision: number }> {
    await this.control.assertManual(context.tx);
    await this.assertNotStarted(context.tx, requestId);

    const engineer = await context.tx.engineer.findUnique({ where: { id: toEngineerId } });
    if (!engineer) {
      throw SysError.notFound('Engineer', { engineerId: toEngineerId });
    }

    const revision = await this.plans.beginManualRevision(
      context.tx,
      context.now,
      context.actor.id,
      `reassign ${requestId} to ${toEngineerId}`,
    );

    // Remove the stop from wherever it currently sits.
    const routes = await context.tx.appliedPlanRoute.findMany({
      where: { planId: revision.id },
      include: { stops: true },
    });
    for (const route of routes) {
      const stop = route.stops.find((item) => item.requestId === requestId);
      if (stop) {
        await context.tx.appliedPlanStop.delete({ where: { id: stop.id } });
      }
    }

    const target =
      routes.find((route) => route.engineerId === toEngineerId) ??
      (await context.tx.appliedPlanRoute.create({
        data: {
          planId: revision.id,
          engineerId: toEngineerId,
          startLat: engineer.homeLat ?? 0,
          startLon: engineer.homeLon ?? 0,
          lunchStatus: 'not_scheduled',
          reasons: [],
        },
      }));

    const request = await context.tx.request.findUniqueOrThrow({ where: { id: requestId } });
    const last = await context.tx.appliedPlanStop.findFirst({
      where: { routeId: target.id },
      orderBy: { sequence: 'desc' },
    });

    await context.tx.appliedPlanStop.create({
      data: {
        routeId: target.id,
        sequence: (last?.sequence ?? -1) + 1,
        kind: 'job',
        requestId,
        lat: request.lat ?? 0,
        lon: request.lon ?? 0,
        // The times carried over are the ones the request already had. They are not
        // recomputed here, and the interface must not present them as if they were.
        arrivalAt: request.windowStartAt,
        startAt: request.windowStartAt,
        endAt: request.windowStartAt + BigInt(request.serviceDurationSec),
      },
    });

    await context.tx.appliedPlanAssignment.updateMany({
      where: { planId: revision.id, requestId },
      data: { status: 'assigned', engineerId: toEngineerId },
    });

    await this.plans.publishRevision(context.tx, context.now, revision.id);
    return { planRevision: revision.revision };
  }

  /**
   * Reorders one engineer's queue.
   *
   * Saved once per completed drop. Work that has started keeps its place: a manual
   * reorder never touches it or its history (context/39 DB5).
   */
  async reorder(
    context: OperationContext,
    engineerId: string,
    orderedRequestIds: string[],
  ): Promise<{ planRevision: number }> {
    await this.control.assertManual(context.tx);
    for (const requestId of orderedRequestIds) {
      await this.assertNotStarted(context.tx, requestId);
    }

    const revision = await this.plans.beginManualRevision(
      context.tx,
      context.now,
      context.actor.id,
      `reorder queue of ${engineerId}`,
    );

    const route = await context.tx.appliedPlanRoute.findFirst({
      where: { planId: revision.id, engineerId },
      include: { stops: { orderBy: { sequence: 'asc' } } },
    });
    if (!route) {
      throw SysError.notFound('Route for engineer', { engineerId });
    }

    const known = new Set(route.stops.filter((s) => s.requestId).map((s) => s.requestId));
    const unknown = orderedRequestIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new SysError('VALIDATION_FAILED', 'These requests are not in this queue', {
        details: { requestIds: unknown },
      });
    }

    // Sequences are rewritten in two passes through a temporary offset, because the
    // (route, sequence) pair is unique and a direct rewrite would collide mid-way.
    const offset = route.stops.length + 1000;
    for (const stop of route.stops) {
      await context.tx.appliedPlanStop.update({
        where: { id: stop.id },
        data: { sequence: stop.sequence + offset },
      });
    }

    let sequence = 0;
    for (const requestId of orderedRequestIds) {
      const stop = route.stops.find((item) => item.requestId === requestId);
      if (stop) {
        await context.tx.appliedPlanStop.update({
          where: { id: stop.id },
          data: { sequence },
        });
        sequence += 1;
      }
    }
    // Lunch and waiting stops keep their relative order after the reordered work.
    for (const stop of route.stops.filter((item) => item.requestId === null)) {
      await context.tx.appliedPlanStop.update({ where: { id: stop.id }, data: { sequence } });
      sequence += 1;
    }

    await this.plans.publishRevision(context.tx, context.now, revision.id);
    return { planRevision: revision.revision };
  }

  private async assertNotStarted(tx: Tx, requestId: string): Promise<void> {
    const request = await tx.request.findUnique({ where: { id: requestId } });
    if (!request) {
      throw SysError.notFound('Request', { requestId });
    }
    if (request.startedAt !== null || request.lifecycle === 'in_progress') {
      throw new SysError('WORK_ALREADY_STARTED', 'This work has already started', {
        details: { requestId },
      });
    }
  }
}
