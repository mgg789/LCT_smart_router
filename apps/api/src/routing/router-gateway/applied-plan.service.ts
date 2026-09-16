import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { type AppliedPlan, Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../persistence';
import type { RouterPlan, RouterResult } from './result.types';

/**
 * The working plan the interfaces actually run on.
 *
 * Every acceptance adds an **immutable revision** rather than editing the previous one,
 * so history, comparison and "before and after" come for free (D-10). A pointer names the
 * revision in force.
 *
 * The plan carries its own moment: `planAsOf` is the `planning_as_of` of the result that
 * was applied, or the time of the manual edit. It is never the timestamp of a newer,
 * not-yet-computed snapshot -- while a recalculation is under way the interface shows the
 * last applied plan together with the moment it describes (context/36 section 6).
 */
@Injectable()
export class AppliedPlanService {
  /** Stores an accepted automatic result as the new working plan. */
  async applyAutomatic(
    tx: Tx,
    now: number,
    result: RouterResult,
    routerResultId: string,
  ): Promise<AppliedPlan> {
    const main = result.main;
    if (!main) {
      throw new SysError('RESULT_NOT_APPLICABLE', 'The result carries no main plan');
    }

    const plan = await tx.appliedPlan.create({
      data: {
        origin: 'auto',
        routerResultId,
        // The moment the shown plan describes, taken from the result that produced it.
        planAsOf: BigInt(result.planning_as_of ?? now),
        appliedAt: BigInt(now),
        note: `result ${result.result_id}`,
      },
    });

    await this.materialise(tx, plan.id, main);
    await this.syncAssignmentStates(tx, now, main);
    await this.movePointer(tx, now, plan.id);
    await this.storeAlerts(tx, now, main, result.result_id);

    return plan;
  }

  /** The revision in force, with everything an interface needs to draw it. */
  async current(tx: Tx) {
    const pointer = await tx.appliedPlanCurrent.findUnique({
      where: { id: 'singleton' },
      include: {
        plan: {
          include: {
            routerResult: true,
            routes: { include: { stops: { orderBy: { sequence: 'asc' } } } },
            assignments: true,
          },
        },
      },
    });
    return pointer?.plan ?? null;
  }

  /**
   * Freezes the current plan as the starting point for manual control.
   *
   * Switching to MANUAL does not make the plan immutable; it makes the dispatcher its
   * author (context/32 section 7.1).
   */
  async freezeForManual(tx: Tx, now: number, actorId: string): Promise<string | null> {
    const current = await this.current(tx);
    if (!current) {
      return null;
    }
    await tx.controlState.update({
      where: { id: 'singleton' },
      data: { frozenPlanId: current.id, changedAt: BigInt(now), changedBy: actorId },
    });
    return current.id;
  }

  /**
   * Creates a manual revision by copying the current one.
   *
   * A manual edit is a new revision like any other, so the history stays a single line
   * and the origin of each plan is visible.
   */
  async beginManualRevision(tx: Tx, now: number, actorId: string, note: string) {
    const current = await this.current(tx);
    if (!current) {
      throw SysError.notFound('Applied plan');
    }

    const revision = await tx.appliedPlan.create({
      data: {
        origin: 'manual',
        routerResultId: current.routerResultId,
        // A manual plan describes the moment it was edited, not the moment of the
        // automatic result it started from.
        planAsOf: BigInt(now),
        appliedAt: BigInt(now),
        createdBy: actorId,
        note,
      },
    });

    for (const route of current.routes) {
      const copy = await tx.appliedPlanRoute.create({
        data: {
          planId: revision.id,
          engineerId: route.engineerId,
          startLat: route.startLat,
          startLon: route.startLon,
          startAt: route.startAt,
          finishAt: route.finishAt,
          distanceKm: route.distanceKm,
          travelTimeSec: route.travelTimeSec,
          workTimeSec: route.workTimeSec,
          waitingTimeSec: route.waitingTimeSec,
          lunchTimeSec: route.lunchTimeSec,
          assignedCount: route.assignedCount,
          lunchStatus: route.lunchStatus,
          reasons: route.reasons as object,
        },
      });
      for (const stop of route.stops) {
        await tx.appliedPlanStop.create({
          data: {
            routeId: copy.id,
            sequence: stop.sequence,
            kind: stop.kind,
            requestId: stop.requestId,
            lat: stop.lat,
            lon: stop.lon,
            arrivalAt: stop.arrivalAt,
            startAt: stop.startAt,
            endAt: stop.endAt,
          },
        });
      }
    }

    for (const item of current.assignments) {
      await tx.appliedPlanAssignment.create({
        data: {
          planId: revision.id,
          requestId: item.requestId,
          status: item.status,
          engineerId: item.engineerId,
          reasons: item.reasons as object,
        },
      });
    }

    return revision;
  }

  async publishRevision(tx: Tx, now: number, planId: string): Promise<void> {
    await this.movePointer(tx, now, planId);
  }

  private async materialise(tx: Tx, planId: string, plan: RouterPlan): Promise<void> {
    for (const route of plan.routes) {
      const stored = await tx.appliedPlanRoute.create({
        data: {
          planId,
          engineerId: route.engineer_id,
          startLat: route.start_location.lat,
          startLon: route.start_location.lon,
          startAt: route.start_at === null ? null : BigInt(route.start_at),
          finishAt: route.finish_at === null ? null : BigInt(route.finish_at),
          distanceKm: route.metrics.distance_km,
          travelTimeSec: route.metrics.travel_time_sec,
          workTimeSec: route.metrics.work_time_sec,
          waitingTimeSec: route.metrics.waiting_time_sec,
          lunchTimeSec: route.metrics.lunch_time_sec,
          assignedCount: route.metrics.assigned_count,
          lunchStatus: route.lunch.status,
          reasons: route.reasons as object,
        },
      });

      for (const stop of route.stops) {
        await tx.appliedPlanStop.create({
          data: {
            routeId: stored.id,
            sequence: stop.sequence,
            kind: stop.kind,
            requestId: stop.request_id,
            lat: stop.location.lat,
            lon: stop.location.lon,
            arrivalAt: BigInt(stop.arrival_at),
            startAt: BigInt(stop.start_at),
            endAt: BigInt(stop.end_at),
          },
        });
      }
    }

    for (const item of plan.assignments) {
      await tx.appliedPlanAssignment.create({
        data: {
          planId,
          requestId: item.request_id,
          status: item.status,
          engineerId: item.engineer_id,
          // Checkable grounds from the solver, stored as they arrived.
          reasons: item.reasons as object,
        },
      });
    }
  }

  /**
   * Reflects the outcome of distribution on each request.
   *
   * Only the assignment state is touched. The business stage and the facts belong to the
   * engineer and the customer, and a new plan never rewrites them (context/36 section 3).
   */
  private async syncAssignmentStates(tx: Tx, now: number, plan: RouterPlan): Promise<void> {
    for (const item of plan.assignments) {
      await tx.request.updateMany({
        where: {
          id: item.request_id,
          // Started, finished and cancelled work keeps the state it earned.
          lifecycle: 'submitted',
          startedAt: null,
        },
        data: {
          assignmentState: item.status,
          updatedAt: BigInt(now),
          version: { increment: 1 },
        },
      });
    }
  }

  private async movePointer(tx: Tx, now: number, planId: string): Promise<void> {
    await tx.appliedPlanCurrent.upsert({
      where: { id: 'singleton' },
      update: { planId, pointerVersion: { increment: 1 }, updatedAt: BigInt(now) },
      create: { id: 'singleton', planId, pointerVersion: 1, updatedAt: BigInt(now) },
    });
  }

  /**
   * Stores the explainable problems the plan reported.
   *
   * An alert is created once per `alert_id`: a repeated result carrying the same problem
   * does not multiply the dispatcher's list.
   */
  private async storeAlerts(
    tx: Tx,
    now: number,
    plan: RouterPlan,
    resultId: string | null,
  ): Promise<void> {
    for (const alert of plan.alerts) {
      const existing = await tx.alert.findFirst({ where: { id: alert.alert_id } });
      if (existing) {
        continue;
      }
      await tx.alert.create({
        data: {
          id: alert.alert_id,
          code: alert.code,
          severity: alert.severity,
          engineerIds: alert.engineer_ids,
          requestIds: alert.request_ids,
          reasons: alert.reasons as object,
          // Absent unless Router actually verified a way out. A guess is never presented
          // as a guaranteed fix, and Prisma's DbNull is how "no verified option" is
          // stored rather than an empty object that would read as one (context/33 §6).
          restoreOption: alert.restore_option ?? Prisma.DbNull,
          sourceResultId: resultId,
          createdAt: BigInt(now),
        },
      });
    }
  }
}
