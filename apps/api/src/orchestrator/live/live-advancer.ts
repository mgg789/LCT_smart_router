import { zonedWallUnix } from '../../common/time/zone';
import type { LiveEngineerState, LiveWorkday } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { AppliedPlanService } from '../../routing/router-gateway';
import { EngineersService } from '../engineers';
import {
  ExecutionTimingPolicy,
  type ExecutionTimingPolicyValue,
} from '../facts/execution-timing-policy';
import { LiveDayState } from './live-day-state';
import { MATERIAL_DELAY_SEC, NO_SHOW_SEC } from './replan-policy';

const POST_LUNCH_HANDOFF_GRACE_SEC = 5 * 60;

/** Applies automatic LIVE transitions while the caller owns the transaction. */
export class LiveAdvancer {
  constructor(
    private readonly dayState: LiveDayState,
    private readonly engineers: EngineersService,
    private readonly plans: AppliedPlanService,
    private readonly publisher: SnapshotPublisher,
    private readonly timing: ExecutionTimingPolicy,
    private readonly canEngineerFinishDay: (
      tx: Tx,
      day: LiveWorkday,
      state: LiveEngineerState,
      liveNow: number,
    ) => Promise<boolean>,
    private readonly upsertRequestState: (
      tx: Tx,
      workdayId: string,
      requestId: string,
      wallNow: number,
      data: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}

  /** Archived and synthetic leftovers are not a roster the coordinator can mutate. */
  private async activeRosterEngineer(tx: Tx, engineerId: string): Promise<boolean> {
    const engineer = await tx.engineer.findFirst({
      where: { id: engineerId, archivedAt: null },
      select: { id: true },
    });
    return engineer !== null;
  }

  async advanceIn(
    tx: Tx,
    day: LiveWorkday,
    wallNow: number,
    liveNow: number,
    timing: ExecutionTimingPolicyValue = this.timing.current(),
  ): Promise<void> {
    if (day.status !== 'running') return;
    // All readers and the timer serialize automatic transitions for one day. Without
    // this, two tabs crossing the no-show boundary could publish competing snapshots.
    await tx.$queryRaw`SELECT id FROM live_workdays WHERE id = ${day.id} FOR UPDATE`;
    await this.dayState.ensureEngineerStates(tx, day.id, wallNow);
    let availabilityChanged = false;
    if (liveNow >= Number(day.logicalStartAt) + NO_SHOW_SEC) {
      const pending = await tx.liveEngineerState.findMany({
        where: { workdayId: day.id, lineStatus: 'pending' },
      });
      for (const state of pending) {
        await tx.liveEngineerState.update({
          where: { id: state.id },
          data: {
            lineStatus: 'no_show_offline',
            noShowAt: day.logicalStartAt + BigInt(NO_SHOW_SEC),
            updatedAt: BigInt(wallNow),
            version: { increment: 1 },
          },
        });
        // An archived covering crew can still have a pending LIVE row. Taking it
        // offline goes through the roster, which only loads active engineers, and
        // that lookup must not fail the whole day clock.
        if (!(await this.activeRosterEngineer(tx, state.engineerId))) continue;
        const operation: OperationContext = {
          tx,
          now: liveNow,
          businessTime: true,
          actor: {
            kind: 'system',
            id: 'live-coordinator',
            source: 'system',
            role: null,
            tokenCategory: null,
            accountId: null,
          },
          operationId: `live-no-show-${day.id}-${state.engineerId}`,
        };
        await this.engineers.setAvailability(operation, state.engineerId, 'offline', null, {
          publish: false,
        });
        availabilityChanged = true;
      }
    }
    const overdueBreaks = await tx.liveEngineerState.findMany({
      where: {
        workdayId: day.id,
        lineStatus: 'technical_break',
        technicalBreakOverdueAt: { lte: BigInt(liveNow) },
      },
    });
    for (const state of overdueBreaks) {
      const id = `live-break-overdue-${day.id}-${state.engineerId}-${state.technicalBreakStartedAt}`;
      const exists = await tx.alert.findUnique({ where: { id } });
      if (!exists) {
        await tx.alert.create({
          data: {
            id,
            code: 'LIVE_TECHNICAL_BREAK_OVERRUN',
            severity: 'warning',
            engineerIds: [state.engineerId],
            requestIds: [],
            reasons: [
              {
                code: 'LIVE_TECHNICAL_BREAK_OVERRUN',
                text: 'Технический перерыв превысил 20 минут. Инженер исключён из оставшегося плана до возвращения.',
                facts: { workdayId: day.id, overdueAt: Number(state.technicalBreakOverdueAt) },
              },
            ],
            createdAt: BigInt(liveNow),
          },
        });
        // The original +15m forecast is stale once this becomes an incident.  Keep the
        // engineer unavailable until an explicit break_finish and publish that capacity
        // withdrawal exactly once with the alert.
        const operation: OperationContext = {
          tx,
          now: liveNow,
          businessTime: true,
          actor: {
            kind: 'system',
            id: 'live-coordinator',
            source: 'system',
            role: null,
            tokenCategory: null,
            accountId: null,
          },
          operationId: `live-break-overdue-${day.id}-${state.engineerId}-${state.technicalBreakStartedAt}`,
        };
        if (!(await this.activeRosterEngineer(tx, state.engineerId))) continue;
        await this.engineers.setAvailability(operation, state.engineerId, 'offline', null, {
          publish: false,
        });
        availabilityChanged = true;
      }
    }
    if (availabilityChanged) {
      await this.publisher.publishIfChanged(
        tx,
        liveNow,
        PUBLICATION_TRIGGERS.ENGINEER_AVAILABILITY_CHANGED,
        { businessTime: true },
      );
    }
    const plan = await this.plans.currentSchedule(tx);
    for (const route of plan?.routes ?? []) {
      const lunch = route.stops.find(
        (stop) =>
          stop.kind === 'lunch' && stop.startAt <= BigInt(liveNow) && BigInt(liveNow) < stop.endAt,
      );
      if (!lunch) continue;
      const line = await tx.liveEngineerState.findUnique({
        where: { workdayId_engineerId: { workdayId: day.id, engineerId: route.engineerId } },
      });
      if (line?.lineStatus !== 'online') continue;
      const working = await tx.requestFact.count({
        where: {
          engineerId: route.engineerId,
          kind: 'started',
          request: { lifecycle: 'in_progress' },
        },
      });
      if (working > 0) continue;
      const updated = await tx.engineerDay.updateMany({
        where: {
          engineerId: route.engineerId,
          workDate: day.workDate,
          lunchEnabled: true,
          lunchTaken: false,
        },
        data: {
          lunchTaken: true,
          lunchStartedAt: lunch.startAt,
          updatedAt: BigInt(wallNow),
          version: { increment: 1 },
        },
      });
      if (updated.count > 0) {
        await tx.liveEngineerState.updateMany({
          where: { workdayId: day.id, engineerId: route.engineerId },
          data: {
            activeLunchLat: lunch.lat,
            activeLunchLon: lunch.lon,
            activeLunchStartedAt: lunch.startAt,
            updatedAt: BigInt(wallNow),
            version: { increment: 1 },
          },
        });
      }
    }
    const assumed = await tx.liveRequestState.findMany({
      where: { workdayId: day.id },
      select: {
        requestId: true,
        reservedEngineerId: true,
        assumedStartedAt: true,
        assumedCompletedAt: true,
        reportedEtaAt: true,
      },
    });
    const already = new Set(
      assumed.filter((item) => item.assumedCompletedAt !== null).map((item) => item.requestId),
    );
    const etaByRequest = new Map(
      assumed.flatMap((item) => {
        const startAt = item.reportedEtaAt ?? item.assumedStartedAt;
        return startAt === null ? [] : [[item.requestId, Number(startAt)] as const];
      }),
    );
    const serviceByRequest = new Map(
      (
        await tx.request.findMany({
          where: { id: { in: [...etaByRequest.keys()] } },
          select: { id: true, serviceDurationSec: true },
        })
      ).map((item) => [item.id, item.serviceDurationSec]),
    );
    const explicit = await tx.request.findMany({
      where: {
        OR: [
          { lifecycle: { in: ['in_progress', 'completed', 'cancelled'] } },
          { startedAt: { not: null } },
        ],
      },
      select: { id: true },
    });
    const protectedIds = new Set(explicit.map((item) => item.id));
    const appActiveFacts = await tx.requestFact.findMany({
      where: { kind: 'finished', request: { liveStates: { some: { workdayId: day.id } } } },
      select: { engineerId: true },
    });
    const appActiveEngineers = new Set(appActiveFacts.map((fact) => fact.engineerId));
    for (const route of plan?.routes ?? []) {
      const liveState = await tx.liveEngineerState.findUnique({
        where: { workdayId_engineerId: { workdayId: day.id, engineerId: route.engineerId } },
      });
      if (liveState?.lineStatus !== 'online') continue;
      const dayState = await tx.engineerDay.findUnique({
        where: { engineerId_workDate: { engineerId: route.engineerId, workDate: day.workDate } },
        select: { lunchDurationSec: true, attendanceOptOut: true },
      });
      if (appActiveEngineers.has(route.engineerId) && !dayState?.attendanceOptOut) continue;
      const lunchDurationSec = dayState?.lunchDurationSec ?? null;
      const lunchEndsAt =
        liveState.activeLunchStartedAt !== null && lunchDurationSec !== null
          ? Number(liveState.activeLunchStartedAt) + lunchDurationSec
          : null;
      // While the automatic lunch interval is live, the schedule must not manufacture
      // a job arrival or completion. The snapshot separately keeps this engineer at
      // the lunch point until that durable release moment.
      if (lunchEndsAt !== null && liveNow < lunchEndsAt) continue;
      const postLunchHandoffEndsAt =
        lunchEndsAt === null ? null : lunchEndsAt + POST_LUNCH_HANDOFF_GRACE_SEC;
      const firstJobAfterLunch =
        liveState.activeLunchLat === null || liveState.activeLunchLon === null
          ? null
          : (() => {
              const lunchStop = route.stops.find(
                (stop) =>
                  stop.kind === 'lunch' &&
                  stop.lat === liveState.activeLunchLat &&
                  stop.lon === liveState.activeLunchLon,
              );
              return route.stops.find(
                (stop) =>
                  stop.kind === 'job' &&
                  stop.requestId !== null &&
                  (lunchStop === undefined || stop.sequence > lunchStop.sequence),
              );
            })();
      const activeVisit = await tx.request.findFirst({
        where: {
          lifecycle: 'in_progress',
          facts: { some: { engineerId: route.engineerId, kind: 'started' } },
        },
        select: { id: true },
      });
      if (activeVisit) continue;
      const pendingMeetings = await tx.equipmentHandoff.findMany({
        where: {
          workDate: day.workDate,
          completedAt: null,
          OR: [{ donorEngineerId: route.engineerId }, { receiverEngineerId: route.engineerId }],
        },
      });
      for (const stop of route.stops) {
        // A clock cannot manufacture receipt of physical equipment.
        if (pendingMeetings.some((meeting) => Number(meeting.meetingAt) <= Number(stop.startAt)))
          break;
        if (
          stop.kind !== 'job' ||
          !stop.requestId ||
          already.has(stop.requestId) ||
          protectedIds.has(stop.requestId)
        )
          continue;
        // The next visit stays interactive just after lunch. It gives the engineer a
        // deterministic chance to confirm arrival and keeps the compound lunch edge
        // visible; once five logical minutes pass, the normal silent-schedule rule
        // resumes and may advance that same visit.
        if (
          postLunchHandoffEndsAt !== null &&
          liveNow < postLunchHandoffEndsAt &&
          stop.requestId === firstJobAfterLunch?.requestId
        )
          continue;
        const eta = etaByRequest.get(stop.requestId);
        const assumedStartAt = eta ?? Number(stop.startAt);
        const assumedEndAt =
          eta === undefined
            ? Number(stop.endAt)
            : eta + (serviceByRequest.get(stop.requestId) ?? 0);
        if (assumedStartAt <= liveNow && liveNow < assumedEndAt) {
          const prior = assumed.find((item) => item.requestId === stop.requestId);
          if (
            prior?.assumedStartedAt === null ||
            prior === undefined ||
            prior.reservedEngineerId !== route.engineerId
          ) {
            await this.upsertRequestState(tx, day.id, stop.requestId, wallNow, {
              assumedStartedAt: BigInt(assumedStartAt),
              reservedEngineerId: route.engineerId,
            });
            await tx.liveEngineerState.update({
              where: { id: liveState.id },
              data: {
                routeAnchorRequestId: stop.requestId,
                routeAnchorReachedAt: BigInt(assumedStartAt),
                routeAnchorDepartedAt: null,
                activeLunchLat: null,
                activeLunchLon: null,
                activeLunchStartedAt: null,
                updatedAt: BigInt(wallNow),
                version: { increment: 1 },
              },
            });
          }
          continue;
        }
        if (assumedEndAt > liveNow) continue;
        if (!already.has(stop.requestId)) {
          await this.upsertRequestState(tx, day.id, stop.requestId, wallNow, {
            assumedStartedAt: BigInt(assumedStartAt),
            assumedCompletedAt: BigInt(assumedEndAt),
            reservedEngineerId: route.engineerId,
          });
          await tx.liveEngineerState.update({
            where: { id: liveState.id },
            data: {
              routeAnchorRequestId: stop.requestId,
              routeAnchorReachedAt: BigInt(assumedStartAt),
              routeAnchorDepartedAt: BigInt(assumedEndAt),
              activeLunchLat: null,
              activeLunchLon: null,
              activeLunchStartedAt: null,
              updatedAt: BigInt(wallNow),
              version: { increment: 1 },
            },
          });
        }
      }
    }
    // A reported ETA is deliberately excluded from the new Router input to preserve its
    // current owner. Once its reserved service interval ends without an explicit mark,
    // the same silence rule closes the LIVE assumption even though the rebuilt plan no
    // longer contains that stop.
    for (const [requestId, eta] of etaByRequest) {
      if (already.has(requestId) || protectedIds.has(requestId)) continue;
      const owner = assumed.find((item) => item.requestId === requestId)?.reservedEngineerId;
      if (!owner) continue;
      const ownerState = await tx.liveEngineerState.findUnique({
        where: { workdayId_engineerId: { workdayId: day.id, engineerId: owner } },
      });
      if (ownerState?.lineStatus !== 'online') continue;
      const activeVisit = await tx.request.findFirst({
        where: {
          lifecycle: 'in_progress',
          facts: { some: { engineerId: owner, kind: 'started' } },
        },
        select: { id: true },
      });
      if (activeVisit) continue;
      const endAt = eta + (serviceByRequest.get(requestId) ?? 0);
      if (endAt <= liveNow) {
        await this.upsertRequestState(tx, day.id, requestId, wallNow, {
          assumedStartedAt: BigInt(eta),
          assumedCompletedAt: BigInt(endAt),
        });
        await tx.liveEngineerState.updateMany({
          where: { workdayId: day.id, engineerId: owner },
          data: {
            routeAnchorRequestId: requestId,
            routeAnchorReachedAt: BigInt(eta),
            routeAnchorDepartedAt: BigInt(endAt),
            activeLunchLat: null,
            activeLunchLon: null,
            activeLunchStartedAt: null,
            updatedAt: BigInt(wallNow),
            version: { increment: 1 },
          },
        });
      }
    }
    // The legacy coordinator intentionally follows wall time for ordinary API use. LIVE
    // advances a virtual clock, therefore its overrun gate lives here and writes the
    // exact same durable request field/Router trigger.
    const materialOverruns = await tx.request.findMany({
      where: {
        lifecycle: 'in_progress',
        liveStates: { some: { workdayId: day.id } },
        startedAt: { not: null },
      },
      select: { id: true, startedAt: true, serviceDurationSec: true, overrunDetectedAt: true },
    });
    let materialChanged = false;
    for (const request of materialOverruns) {
      if (
        request.startedAt !== null &&
        request.overrunDetectedAt === null &&
        liveNow >
          Number(request.startedAt) + request.serviceDurationSec + timing.taskOverrunToleranceSec
      ) {
        await tx.request.update({
          where: { id: request.id },
          data: {
            overrunDetectedAt: BigInt(liveNow),
            updatedAt: BigInt(liveNow),
            version: { increment: 1 },
          },
        });
      }
      if (
        request.startedAt === null ||
        liveNow <= Number(request.startedAt) + request.serviceDurationSec + MATERIAL_DELAY_SEC
      )
        continue;
      const key = `live.material-overrun.${day.id}.${request.id}`;
      if (await tx.appState.findUnique({ where: { key } })) continue;
      await tx.appState.create({
        data: { key, value: { requestId: request.id }, updatedAt: BigInt(liveNow) },
      });
      materialChanged = true;
    }
    if (materialChanged) {
      await this.publisher.publishIfChanged(
        tx,
        liveNow,
        PUBLICATION_TRIGGERS.REQUEST_EXECUTION_OVERRUN,
        { businessTime: true },
      );
    }
    const unfinished = await tx.request.count({
      where: { lifecycle: 'in_progress', liveStates: { some: { workdayId: day.id } } },
    });
    // Removing an engineer from the shift is a final dispatcher decision for this day.
    // Stale LIVE markers must not keep the dispatcher session open afterwards: an
    // engineer can have entered a break/lunch immediately before the removal action.
    // A regular technical break still blocks because its day is not opted out.
    const participatingDays = await tx.engineerDay.findMany({
      where: { workDate: day.workDate, attendanceOptOut: false },
      select: { engineerId: true },
    });
    const participatingEngineerIds = participatingDays.map((item) => item.engineerId);
    const technicalBreak = await tx.liveEngineerState.count({
      where: {
        workdayId: day.id,
        engineerId: { in: participatingEngineerIds },
        lineStatus: 'technical_break',
      },
    });
    const lunches = await tx.engineerDay.findMany({
      where: {
        workDate: day.workDate,
        attendanceOptOut: false,
        lunchTaken: true,
        lunchStartedAt: { not: null },
      },
      select: { lunchStartedAt: true, lunchDurationSec: true },
    });
    const activeLunch = lunches.some(
      (item) =>
        item.lunchStartedAt !== null &&
        item.lunchDurationSec !== null &&
        Number(item.lunchStartedAt) <= liveNow &&
        liveNow < Number(item.lunchStartedAt) + item.lunchDurationSec,
    );
    const dayStart = zonedWallUnix(`${day.workDate}T00:00:00`);
    const pendingToday = await tx.request.count({
      where: {
        lifecycle: 'submitted',
        windowStartAt: { lt: BigInt(dayStart + 86_400) },
        windowEndAt: { gte: BigInt(dayStart) },
        liveStates: { none: { workdayId: day.id, assumedCompletedAt: { not: null } } },
      },
    });
    const unresolved = await tx.alert.count({
      where: {
        kind: 'alert',
        isBlocking: true,
        resolvedAt: null,
        invalidatedAt: null,
        OR: [{ workDate: day.workDate }, { workDate: null }],
      },
    });
    const canFinish =
      liveNow >= dayStart + 17 * 3600 &&
      unfinished === 0 &&
      pendingToday === 0 &&
      unresolved === 0 &&
      technicalBreak === 0 &&
      !activeLunch;
    const finishingEngineers = await tx.liveEngineerState.findMany({
      where: { workdayId: day.id },
    });
    for (const engineerState of finishingEngineers) {
      if (!(await this.canEngineerFinishDay(tx, day, engineerState, liveNow))) continue;
      const route = { engineerId: engineerState.engineerId };
      const line = await tx.liveEngineerState.findUnique({
        where: { workdayId_engineerId: { workdayId: day.id, engineerId: route.engineerId } },
        include: { engineer: true },
      });
      if (!line?.lineStartedAt || line.lineStatus !== 'online') continue;
      const dedupKey = `notice:engineer-finished:${day.id}:${route.engineerId}`;
      await tx.alert.upsert({
        where: { dedupKey },
        update: {},
        create: {
          dedupKey,
          kind: 'notice',
          code: 'engineer_day_finished',
          severity: 'info',
          engineerIds: [route.engineerId],
          requestIds: [],
          workDate: day.workDate,
          reasons: { text: `${line.engineer.displayName}: все заявки завершены.` },
          isBlocking: false,
          createdAt: BigInt(liveNow),
        },
      });
    }
    if (canFinish) {
      await tx.liveWorkday.update({
        where: { id: day.id, status: 'running' },
        data: {
          status: 'finished',
          finishedAt: BigInt(liveNow),
          completionReason:
            liveNow >= Number(day.logicalEndAt) ? 'logical_end' : 'schedule_exhausted',
          updatedAt: BigInt(wallNow),
          version: { increment: 1 },
        },
      });
      const unresolved = await tx.alert.count({
        where: { kind: 'alert', isBlocking: true, resolvedAt: null, invalidatedAt: null },
      });
      if (unresolved > 0) {
        const dedupKey = `notice:day-finished-alerts:${day.id}`;
        await tx.alert.upsert({
          where: { dedupKey },
          update: {},
          create: {
            dedupKey,
            kind: 'notice',
            code: 'workday_finished_with_alerts',
            severity: 'info',
            engineerIds: [],
            requestIds: [],
            workDate: day.workDate,
            reasons: {
              text: 'Рабочий день завершён. Перед закрытием смены разрешите оставшиеся алерты.',
            },
            isBlocking: false,
            createdAt: BigInt(liveNow),
          },
        });
      }
    }
  }
}
