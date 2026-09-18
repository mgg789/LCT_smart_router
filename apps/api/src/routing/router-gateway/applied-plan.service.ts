import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { type AppliedPlan, Prisma } from '../../generated/prisma/client';
import type { Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../mount-data-eng';
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
  constructor(private readonly publisher: SnapshotPublisher) {}

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

    const usesCoveringExtras = main.routes.some((route) =>
      route.engineer_id.startsWith('covering-'),
    );
    if (usesCoveringExtras) {
      await this.ensureCoveringEngineers(tx, now, main);
    } else {
      await this.archiveCoveringEngineers(tx, now);
    }
    await this.materialise(tx, plan.id, main);
    await this.issueMorningEquipment(tx, now, main);
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
          legs: route.legs === null ? [] : (route.legs as Prisma.InputJsonValue),
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
          legs: route.legs.map((leg) => ({
            legId: leg.leg_id,
            fromStopId: leg.from_stop_id,
            toStopId: leg.to_stop_id,
            departureAt: leg.departure_at,
            arrivalAt: leg.arrival_at,
            travelTimeSec: leg.travel_time_sec,
            distanceKm: leg.distance_km,
            geometry: leg.geometry ?? null,
            travelSource: leg.travel_source,
            trafficFactor: leg.traffic_factor,
          })),
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
   * Freezes the first plan's demand plus one spare as physical engineer-owned stock.
   * Later replans may consume the spare but cannot move stock or issue new units.
   */
  private async issueMorningEquipment(tx: Tx, now: number, plan: RouterPlan): Promise<void> {
    const engineerIds = plan.routes.map((route) => route.engineer_id);
    if (engineerIds.length === 0) {
      return;
    }
    const days = await tx.engineerDay.findMany({
      where: { engineerId: { in: engineerIds }, equipmentIssuedAt: null },
      orderBy: { workDate: 'desc' },
    });
    if (days.length === 0) {
      return;
    }
    const requests = await tx.request.findMany({
      where: { id: { in: plan.assignments.map((assignment) => assignment.request_id) } },
      select: { id: true, requiredEquipment: true },
    });
    const equipmentByRequest = new Map(
      requests.map((request) => [request.id, request.requiredEquipment]),
    );
    const demand = new Map<
      string,
      { equipmentRouter: number; equipmentSetTopBox: number; equipmentSmartSpeaker: number }
    >();
    for (const assignment of plan.assignments) {
      if (assignment.status !== 'assigned' || !assignment.engineer_id) {
        continue;
      }
      const equipment = equipmentByRequest.get(assignment.request_id);
      if (!equipment) {
        continue;
      }
      const row = demand.get(assignment.engineer_id) ?? {
        equipmentRouter: 0,
        equipmentSetTopBox: 0,
        equipmentSmartSpeaker: 0,
      };
      if (equipment === 'router') row.equipmentRouter += 1;
      if (equipment === 'set_top_box') row.equipmentSetTopBox += 1;
      if (equipment === 'smart_speaker') row.equipmentSmartSpeaker += 1;
      demand.set(assignment.engineer_id, row);
    }

    const seen = new Set<string>();
    for (const day of days) {
      if (seen.has(day.engineerId)) {
        continue;
      }
      seen.add(day.engineerId);
      const row = demand.get(day.engineerId) ?? {
        equipmentRouter: 0,
        equipmentSetTopBox: 0,
        equipmentSmartSpeaker: 0,
      };
      await tx.engineerDay.update({
        where: { id: day.id },
        data: {
          equipmentRouter: row.equipmentRouter > 0 ? row.equipmentRouter + 1 : 0,
          equipmentSetTopBox: row.equipmentSetTopBox > 0 ? row.equipmentSetTopBox + 1 : 0,
          equipmentSmartSpeaker: row.equipmentSmartSpeaker > 0 ? row.equipmentSmartSpeaker + 1 : 0,
          equipmentIssuedAt: BigInt(now),
          updatedAt: BigInt(now),
          version: { increment: 1 },
        },
      });
    }
    await this.publisher.publishIfChanged(tx, now, PUBLICATION_TRIGGERS.EQUIPMENT_ISSUED);
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

  /**
   * Hide synthesized covering extras after leaving that policy so they cannot
   * inflate compact/fast/sla/eco/FIFO.
   */
  private async archiveCoveringEngineers(tx: Tx, now: number): Promise<void> {
    const archived = await tx.engineer.updateMany({
      where: { id: { startsWith: 'covering-' }, archivedAt: null },
      data: { archivedAt: BigInt(now), updatedAt: BigInt(now) },
    });
    if (archived.count === 0) {
      return;
    }
    await this.publisher.publishIfChanged(tx, now, PUBLICATION_TRIGGERS.ENGINEER_PROFILE_CHANGED);
  }

  /**
   * Persist synthesized covering-policy engineers so their routes stay visible
   * while covering is the active policy.
   */
  private async ensureCoveringEngineers(tx: Tx, now: number, plan: RouterPlan): Promise<void> {
    const coveringIds = [
      ...new Set(
        plan.routes
          .map((route) => route.engineer_id)
          .filter((engineerId) => engineerId.startsWith('covering-')),
      ),
    ];
    if (coveringIds.length === 0) {
      return;
    }
    const existing = await tx.engineer.findMany({
      where: { id: { in: coveringIds } },
      select: { id: true },
    });
    const known = new Set(existing.map((row) => row.id));
    const missing = coveringIds.filter((engineerId) => !known.has(engineerId));
    if (missing.length === 0) {
      return;
    }
    const templates = await tx.engineer.findMany({
      where: { archivedAt: null },
      include: { days: { orderBy: { workDate: 'desc' }, take: 1 } },
      orderBy: { inputOrder: 'asc' },
    });
    const fallback = templates[0];
    if (!fallback) {
      return;
    }
    const byRegion = new Map<string, (typeof templates)[number]>();
    for (const template of templates) {
      if (template.region && !byRegion.has(template.region)) {
        byRegion.set(template.region, template);
      }
    }
    for (const engineerId of missing) {
      const parsed = /^covering-(.+)-(\d+)$/.exec(engineerId);
      const region = parsed?.[1] ?? fallback.region ?? 'any';
      const index = Number(parsed?.[2] ?? 0);
      const template = byRegion.get(region) ?? fallback;
      const day = template.days[0];
      await tx.engineer.create({
        data: {
          id: engineerId,
          displayName: `Резерв ${region} ${index || engineerId}`,
          inputOrder: 10_000 + index,
          skills: ['local', 'connection', 'emergency'],
          transportType: 'car',
          depotId: template.depotId,
          homeLat: template.homeLat,
          homeLon: template.homeLon,
          region: region === 'any' ? template.region : region,
          origin: 'synthesized',
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
      if (!day) {
        continue;
      }
      await tx.engineerDay.create({
        data: {
          engineerId,
          workDate: day.workDate,
          shiftStartAt: day.shiftStartAt,
          shiftEndAt: day.shiftEndAt,
          lunchEnabled: day.lunchEnabled,
          lunchDurationSec: day.lunchDurationSec,
          lunchWindowStartAt: day.lunchWindowStartAt,
          lunchWindowEndAt: day.lunchWindowEndAt,
          lunchRequired: day.lunchRequired,
          createdAt: BigInt(now),
          updatedAt: BigInt(now),
        },
      });
    }
  }
}
