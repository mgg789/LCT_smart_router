import { Injectable } from '@nestjs/common';
import { asLunchStatus, type PlanRouteView } from '../../api/plan-view';
import type { AppliedPlanCurrentShape } from '../../api/plan-view.types';
import { SysError } from '../../common/errors';
import { reserveNameFor } from '../../common/reserve-name';
import { type AppliedPlan, Prisma } from '../../generated/prisma/client';
import { AlertsService } from '../../orchestrator/alerts';
import { workDateOf } from '../../orchestrator/engineers/workday';
import {
  equipmentCapacity,
  morningIssueBasket,
  readEquipmentSettings,
} from '../../orchestrator/equipment/equipment-policy';
import { persistHandoffs } from '../../orchestrator/equipment/handoffs';
import { persistLogistics } from '../../orchestrator/equipment/logistics';
import type { Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../mount-data-eng';
import {
  handoffMetadataSchema,
  logisticsMetadataSchema,
  type RouterPlan,
  type RouterResult,
} from './result.types';

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
  constructor(
    private readonly publisher: SnapshotPublisher,
    private readonly alerts: AlertsService,
  ) {}

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
      await this.archiveIdleCoveringEngineers(tx, now, main);
    } else {
      await this.archiveCoveringEngineers(tx, now);
    }
    await persistHandoffs(tx, main, workDateOf(result.planning_as_of ?? now, 'Europe/Moscow'), now);
    await persistLogistics(
      tx,
      main,
      workDateOf(result.planning_as_of ?? now, 'Europe/Moscow'),
      now,
    );
    await this.materialise(tx, plan.id, main);
    await this.issueMorningEquipment(tx, now, main, result.status === 'partial');
    await this.syncAssignmentStates(tx, now, main);
    await this.movePointer(tx, now, plan.id);
    await this.storeAlerts(
      tx,
      now,
      main,
      result.result_id,
      workDateOf(result.planning_as_of ?? now, 'Europe/Moscow'),
    );
    await this.alerts.invalidateOtherRouterConditions(tx, now, result.result_id);
    await this.alerts.recordPlanRebuilt(tx, now, result.result_id);

    return plan;
  }

  /** The revision in force, with everything an interface needs to draw it. */
  async insertDelivery(
    tx: Tx,
    now: number,
    expectedRevision: number,
    row: {
      id: string;
      requestId: string;
      donorEngineerId: string;
      receiverEngineerId: string;
      equipmentType: 'router' | 'set_top_box' | 'smart_speaker';
      lat: number;
      lon: number;
      expectedAt: bigint;
      travelDeltaSec: number;
      distanceDeltaM: number;
      waitDeltaSec: number;
      occupiedFrom: number;
      occupiedUntil: number;
    },
  ): Promise<void> {
    const current = await this.current(tx);
    if (!current || current.revision !== expectedRevision)
      throw new SysError('VERSION_CONFLICT', 'The delivery plan changed');
    const route = current.routes.find((item) => item.engineerId === row.donorEngineerId);
    if (!route) throw new SysError('VERSION_CONFLICT', 'The donor route is missing');
    const stop = {
      id: row.id,
      routeId: route.id,
      sequence: 0,
      kind: 'delivery' as const,
      requestId: null,
      handoff: null,
      logistics: {
        logistics_id: row.id,
        kind: 'donor_delivery',
        request_id: row.requestId,
        equipment_type: row.equipmentType,
        donor_engineer_id: row.donorEngineerId,
        receiver_engineer_id: row.receiverEngineerId,
        depot_id: null,
      },
      lat: row.lat,
      lon: row.lon,
      arrivalAt: row.expectedAt,
      startAt: row.expectedAt,
      endAt: row.expectedAt + 300n,
    };
    const retained = route.stops.flatMap((item) => {
      if (
        item.kind !== 'wait' ||
        Number(item.endAt) <= row.occupiedFrom ||
        Number(item.startAt) >= row.occupiedUntil
      )
        return [item];
      const fragments = [];
      if (Number(item.startAt) < row.occupiedFrom)
        fragments.push({ ...item, endAt: BigInt(row.occupiedFrom) });
      if (Number(item.endAt) > row.occupiedUntil)
        fragments.push({
          ...item,
          arrivalAt: BigInt(row.occupiedUntil),
          startAt: BigInt(row.occupiedUntil),
        });
      return fragments;
    });
    route.stops = [...retained, stop]
      .sort((a, b) => Number(a.startAt - b.startAt))
      .map((item, index) => ({ ...item, sequence: index + 1 }));
    route.travelTimeSec = Math.max(0, route.travelTimeSec + row.travelDeltaSec);
    route.distanceKm = Math.max(0, route.distanceKm + row.distanceDeltaM / 1000);
    route.waitingTimeSec = Math.max(0, route.waitingTimeSec + row.waitDeltaSec);
    // Geometry from an earlier route must not claim the new stop was visited.
    route.legs = [];
    route.finishAt =
      route.finishAt === null || route.finishAt < stop.endAt ? stop.endAt : route.finishAt;
    const revision = await this.copyRevision(tx, now, current, {
      origin: 'auto',
      createdBy: 'equipment-logistics',
      note: `Equipment delivery ${row.id}`,
      planAsOf: BigInt(now),
    });
    await this.movePointer(tx, now, revision.id);
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

  /** The immutable revision immediately before `beforeRevision`, including drawable routes. */
  async previous(tx: Tx, beforeRevision: number): Promise<AppliedPlanCurrentShape | null> {
    return tx.appliedPlan.findFirst({
      where: { revision: { lt: beforeRevision } },
      orderBy: { revision: 'desc' },
      include: {
        routerResult: true,
        routes: { include: { stops: { orderBy: { sequence: 'asc' } } } },
        assignments: true,
      },
    });
  }

  /**
   * Stops and engineer ids of the working plan, without road geometry.
   *
   * The LIVE clock reads this every second. `current()` also loads every polyline
   * and the raw Router package, which held the database long enough that passports,
   * engineer actions and the clock itself stopped answering.
   */
  async currentSchedule(tx: Tx) {
    const pointer = await tx.appliedPlanCurrent.findUnique({
      where: { id: 'singleton' },
      select: {
        plan: {
          select: {
            routes: {
              select: {
                engineerId: true,
                stops: {
                  orderBy: { sequence: 'asc' },
                  select: {
                    sequence: true,
                    kind: true,
                    requestId: true,
                    lat: true,
                    lon: true,
                    arrivalAt: true,
                    startAt: true,
                    endAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    return pointer?.plan ?? null;
  }

  /**
   * Working routes without road geometry or the raw Router package.
   *
   * The dispatcher roster and the engineer app poll this every couple of seconds while
   * holding the routing lock. Loading every polyline there kept the lock long enough
   * that login and the next poll timed out.
   */
  async currentRoster(tx: Tx): Promise<{ revision: number; routes: PlanRouteView[] } | null> {
    const pointer = await tx.appliedPlanCurrent.findUnique({
      where: { id: 'singleton' },
      select: {
        plan: {
          select: {
            revision: true,
            routes: {
              select: {
                engineerId: true,
                startLat: true,
                startLon: true,
                startAt: true,
                finishAt: true,
                distanceKm: true,
                travelTimeSec: true,
                workTimeSec: true,
                waitingTimeSec: true,
                lunchTimeSec: true,
                assignedCount: true,
                lunchStatus: true,
                stops: {
                  orderBy: { sequence: 'asc' },
                  select: {
                    sequence: true,
                    kind: true,
                    requestId: true,
                    handoff: true,
                    logistics: true,
                    lat: true,
                    lon: true,
                    arrivalAt: true,
                    startAt: true,
                    endAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const plan = pointer?.plan;
    if (!plan) return null;
    return {
      revision: plan.revision,
      routes: plan.routes.map((route) => ({
        engineerId: route.engineerId,
        startLat: route.startLat,
        startLon: route.startLon,
        startAt: route.startAt === null ? null : Number(route.startAt),
        finishAt: route.finishAt === null ? null : Number(route.finishAt),
        distanceKm: route.distanceKm,
        travelTimeSec: route.travelTimeSec,
        workTimeSec: route.workTimeSec,
        waitingTimeSec: route.waitingTimeSec,
        lunchTimeSec: route.lunchTimeSec,
        assignedCount: route.assignedCount,
        lunchStatus: asLunchStatus(route.lunchStatus),
        legs: [],
        stops: route.stops.map((stop) => ({
          sequence: stop.sequence,
          kind: stop.kind,
          requestId: stop.requestId,
          handoff: handoffMetadataSchema.safeParse(stop.handoff).data ?? null,
          logistics: logisticsMetadataSchema.safeParse(stop.logistics).data ?? null,
          lat: stop.lat,
          lon: stop.lon,
          arrivalAt: Number(stop.arrivalAt),
          startAt: Number(stop.startAt),
          endAt: Number(stop.endAt),
        })),
      })),
    };
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

    return this.copyRevision(tx, now, current, {
      origin: 'manual',
      createdBy: actorId,
      note,
      planAsOf: BigInt(now),
    });
  }

  /** Copies an already accepted revision byte-for-byte into a new immutable restore revision. */
  async restoreRevision(
    tx: Tx,
    now: number,
    source: AppliedPlanCurrentShape,
    actorId: string,
    validatedInputHash: string,
  ): Promise<AppliedPlan> {
    return this.copyRevision(tx, now, source, {
      origin: 'restore',
      createdBy: actorId,
      note: `restore revision ${source.revision}`,
      validatedInputHash,
      planAsOf: source.planAsOf,
    });
  }

  /** Recreates only still-valid handoff reservations for a restored immutable route. */
  async restoreHandoffs(tx: Tx, now: number, source: AppliedPlanCurrentShape): Promise<void> {
    const routes: RouterPlan['routes'] = source.routes.map((route) => ({
      engineer_id: route.engineerId,
      start_location: { lat: route.startLat, lon: route.startLon },
      start_at: route.startAt === null ? null : Number(route.startAt),
      finish_at: route.finishAt === null ? null : Number(route.finishAt),
      stops: route.stops.map((stop) => ({
        stop_id: `restore:${route.engineerId}:${stop.sequence}`,
        sequence: stop.sequence,
        kind: stop.kind,
        request_id: stop.requestId,
        handoff: handoffMetadataSchema.safeParse(stop.handoff).data ?? null,
        logistics: logisticsMetadataSchema.safeParse(stop.logistics).data ?? null,
        location: { lat: stop.lat, lon: stop.lon },
        arrival_at: Number(stop.arrivalAt),
        start_at: Number(stop.startAt),
        end_at: Number(stop.endAt),
      })),
      legs: [],
      lunch: {
        status: route.lunchStatus === 'scheduled' ? 'scheduled' : 'not_scheduled',
        stop_id: null,
        reasons: [],
      },
      metrics: {
        distance_km: route.distanceKm,
        travel_time_sec: route.travelTimeSec,
        work_time_sec: route.workTimeSec,
        waiting_time_sec: route.waitingTimeSec,
        lunch_time_sec: route.lunchTimeSec,
        assigned_count: route.assignedCount,
      },
      reasons: [],
    }));
    const assignments: RouterPlan['assignments'] = source.assignments.flatMap((item) =>
      item.status === 'assigned' || item.status === 'unassigned'
        ? [
            {
              request_id: item.requestId,
              status: item.status,
              engineer_id: item.engineerId,
              stop_id: item.stopId,
              reasons: [],
            },
          ]
        : [],
    );
    await persistHandoffs(
      tx,
      {
        is_usable: true,
        metric_scope: 'snapshot_remaining',
        routes,
        assignments,
        summary: {
          requests_total: assignments.length,
          assigned_count: assignments.filter((item) => item.status === 'assigned').length,
          unassigned_count: assignments.filter((item) => item.status === 'unassigned').length,
          urgent_total: 0,
          urgent_assigned_count: 0,
          engineers_used: routes.filter((route) => route.metrics.assigned_count > 0).length,
          distance_km: routes.reduce((sum, route) => sum + route.metrics.distance_km, 0),
          travel_time_sec: routes.reduce((sum, route) => sum + route.metrics.travel_time_sec, 0),
          work_time_sec: routes.reduce((sum, route) => sum + route.metrics.work_time_sec, 0),
          waiting_time_sec: routes.reduce((sum, route) => sum + route.metrics.waiting_time_sec, 0),
          lunch_time_sec: routes.reduce((sum, route) => sum + route.metrics.lunch_time_sec, 0),
        },
        alerts: [],
      },
      workDateOf(Number(source.planAsOf), 'Europe/Moscow'),
      now,
    );
  }

  private async copyRevision(
    tx: Tx,
    now: number,
    current: AppliedPlanCurrentShape,
    metadata: {
      origin: 'manual' | 'restore' | 'auto';
      createdBy: string;
      note: string;
      planAsOf: bigint;
      validatedInputHash?: string;
    },
  ): Promise<AppliedPlan> {
    const revision = await tx.appliedPlan.create({
      data: {
        origin: metadata.origin,
        routerResultId: current.routerResultId,
        validatedInputHash: metadata.validatedInputHash ?? null,
        planAsOf: metadata.planAsOf,
        appliedAt: BigInt(now),
        createdBy: metadata.createdBy,
        note: metadata.note,
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
            handoff: stop.handoff === null ? Prisma.DbNull : stop.handoff,
            logistics: stop.logistics === null ? Prisma.DbNull : stop.logistics,
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
          stopId: item.stopId,
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
            weatherMultiplierUsed: leg.weather_multiplier_used ?? null,
            ...(leg.segments?.length
              ? {
                  segments: leg.segments.map((segment) => ({
                    geometry: segment.geometry,
                    travelSource: segment.travel_source,
                    travelTimeSec: segment.duration_sec,
                    distanceKm: segment.distance_m / 1000,
                  })),
                }
              : {}),
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
            handoff: stop.handoff ?? Prisma.DbNull,
            logistics: stop.logistics ?? Prisma.DbNull,
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
          stopId: item.stop_id,
          // Checkable grounds from the solver, stored as they arrived.
          reasons: item.reasons as object,
        },
      });
    }
  }

  /**
   * Freezes the first assigning plan's demand plus one spare as physical stock.
   * An engineer with no assignments is left unissued, so an empty import plan cannot
   * erase the roster basket. Later replans may consume the spare but cannot move stock
   * or issue new units.
   */
  private async issueMorningEquipment(
    tx: Tx,
    now: number,
    plan: RouterPlan,
    regionalIncrement = false,
  ): Promise<void> {
    const engineerIds = plan.routes.map((route) => route.engineer_id);
    if (engineerIds.length === 0) {
      return;
    }
    const days = await tx.engineerDay.findMany({
      where: { engineerId: { in: engineerIds }, equipmentIssuedAt: null },
      orderBy: { workDate: 'desc' },
      include: { engineer: true },
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

    const equipmentSettings = await readEquipmentSettings(tx);
    const seen = new Set<string>();
    let issued = false;
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
      const assignedToEngineer = plan.assignments.filter(
        (assignment) =>
          assignment.status === 'assigned' && assignment.engineer_id === day.engineerId,
      ).length;
      const keepsLoadedStock =
        regionalIncrement ||
        plan.routes
          .find((route) => route.engineer_id === day.engineerId)
          ?.stops.some(
            (stop) =>
              stop.kind === 'handoff' || stop.kind === 'delivery' || stop.kind === 'office_pickup',
          );
      const basket = keepsLoadedStock
        ? {
            equipmentRouter: day.equipmentRouter,
            equipmentSetTopBox: day.equipmentSetTopBox,
            equipmentSmartSpeaker: day.equipmentSmartSpeaker,
          }
        : morningIssueBasket(
            row,
            assignedToEngineer,
            equipmentCapacity(day.engineer.transportType, equipmentSettings),
            day.engineer.transportType,
          );
      // No assignments yet: leave the imported basket unissued so the workday plan can use it.
      if (basket === null) continue;
      issued = true;
      await tx.engineerDay.update({
        where: { id: day.id },
        data: {
          ...basket,
          equipmentIssuedAt: BigInt(now),
          updatedAt: BigInt(now),
          version: { increment: 1 },
        },
      });
    }
    // A partial issue freezes the existing physical basket; it does not change the
    // snapshot or invalidate the other regional calculations still in flight.
    if (issued && !regionalIncrement)
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
    workDate: string,
  ): Promise<void> {
    for (const alert of plan.alerts) {
      await this.alerts.ingestRouter(tx, now, {
        id: alert.alert_id,
        code: alert.code,
        severity: alert.severity,
        engineerIds: alert.engineer_ids,
        requestIds: alert.request_ids,
        reasons: alert.reasons as object,
        restoreOption: alert.restore_option ?? null,
        sourceResultId: resultId,
        workDate,
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
   * A reserve with no jobs this shift is not on the roster. The solver already
   * prefers a free base engineer; this drops the leftover row so the board
   * does not keep an empty «Резерв».
   */
  private async archiveIdleCoveringEngineers(tx: Tx, now: number, plan: RouterPlan): Promise<void> {
    const busy = plan.routes
      .filter(
        (route) =>
          route.engineer_id.startsWith('covering-') &&
          route.stops.some((stop) => stop.kind === 'job' && stop.request_id),
      )
      .map((route) => route.engineer_id);
    const archived = await tx.engineer.updateMany({
      where: {
        archivedAt: null,
        AND: [{ id: { startsWith: 'covering-' } }, { id: { notIn: busy } }],
      },
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
          displayName: reserveNameFor(region, index || engineerId),
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
