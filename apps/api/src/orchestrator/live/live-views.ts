import type {
  DispatchLiveView,
  EngineerLiveView,
  LiveEngineerStateView,
  LiveWorkdayView,
} from '../../api/live-view.types';
import { SysError } from '../../common/errors';
import type { LiveEngineerState, LiveWorkday } from '../../generated/prisma/client';
import type { Tx } from '../../persistence';
import { AppliedPlanService } from '../../routing/router-gateway';
import { DemoStandService } from '../demo-stand';
import { handoffView } from '../equipment/handoffs';
import { logisticsView } from '../equipment/logistics';
import { type DayWithStates, LiveDayState } from './live-day-state';
import { LiveReadProjection } from './live-read-projection';
import { LiveRouteQuery } from './live-route-query';

/** Builds role-specific LIVE views from one transaction and one logical day. */
export class LiveViews {
  constructor(
    private readonly dayState: LiveDayState,
    private readonly readProjection: LiveReadProjection,
    private readonly routeQuery: LiveRouteQuery,
    private readonly plans: AppliedPlanService,
    private readonly demoStand: DemoStandService,
  ) {}

  async dispatchViewIn(tx: Tx, wallNow: number): Promise<DispatchLiveView> {
    const day = await this.dayState.ensureDay(tx, wallNow);
    await this.dayState.ensureEngineerStates(tx, day.id, wallNow);
    const full = await this.dayState.dayWithStates(tx, day.id);
    const requestCount = await tx.request.count({
      where: { lifecycle: { in: ['submitted', 'in_progress'] } },
    });
    return {
      workday: await this.dayState.toWorkdayView(tx, full, wallNow, requestCount),
      engineers: await this.engineerStatesView(tx, full, wallNow),
      breaks: await this.breakHistory(tx, full),
      history: await this.historyView(tx, full),
      demoStand: this.demoStand.enabled,
      handoffs: (
        await tx.equipmentHandoff.findMany({
          where: { workDate: full.workDate },
          orderBy: { meetingAt: 'asc' },
        })
      ).map(handoffView),
      logistics: await this.logisticsViews(
        tx,
        full.workDate,
        null,
        this.dayState.liveNow(full, wallNow),
      ),
    };
  }

  private async breakHistory(tx: Tx, day: LiveWorkday): Promise<DispatchLiveView['breaks']> {
    return this.readProjection.breakHistory(tx, day);
  }

  async engineerViewIn(tx: Tx, engineerId: string, wallNow: number): Promise<EngineerLiveView> {
    const day = await this.dayState.ensureDay(tx, wallNow);
    await this.dayState.requireEngineerState(tx, day.id, engineerId, wallNow);
    const full = await this.dayState.dayWithStates(tx, day.id);
    const liveNow = this.dayState.liveNow(full, wallNow);
    const views = await this.engineerStatesView(
      tx,
      {
        ...full,
        engineers: full.engineers.filter((state) => state.engineerId === engineerId),
      },
      wallNow,
    );
    const engineer = views.find((item) => item.id === engineerId);
    if (!engineer) throw SysError.notFound('Engineer', { engineerId });
    const current = await this.routeQuery.currentFor(tx, full, engineerId, liveNow);
    const lunch = await this.routeQuery.activeLunch(
      tx,
      full.workDate,
      engineerId,
      current.route,
      liveNow,
    );
    return {
      workday: await this.dayState.toWorkdayView(
        tx,
        full,
        wallNow,
        await tx.request.count({ where: { lifecycle: { in: ['submitted', 'in_progress'] } } }),
      ),
      engineer,
      route: current.route,
      handoffs: (
        await tx.equipmentHandoff.findMany({
          where: {
            workDate: full.workDate,
            OR: [{ donorEngineerId: engineerId }, { receiverEngineerId: engineerId }],
          },
          orderBy: { meetingAt: 'asc' },
        })
      ).map(handoffView),
      logistics: await this.logisticsViews(
        tx,
        full.workDate,
        engineerId,
        this.dayState.liveNow(full, wallNow),
      ),
      current: current.current,
      lunch,
    };
  }

  private async logisticsViews(tx: Tx, workDate: string, viewerId: string | null, now: number) {
    const rows = await tx.equipmentLogistics.findMany({
      where: {
        workDate,
        ...(viewerId
          ? { OR: [{ donorEngineerId: viewerId }, { receiverEngineerId: viewerId }] }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    const donorIds = [
      ...new Set(rows.flatMap((row) => (row.donorEngineerId ? [row.donorEngineerId] : []))),
    ];
    const donors = new Map(
      (
        await tx.engineer.findMany({
          where: { id: { in: donorIds } },
          select: { id: true, displayName: true },
        })
      ).map((row) => [row.id, row.displayName]),
    );
    return rows.map((row) =>
      logisticsView(
        row,
        viewerId,
        row.donorEngineerId ? (donors.get(row.donorEngineerId) ?? null) : null,
        now,
      ),
    );
  }

  private async engineerStatesView(
    tx: Tx,
    day: DayWithStates,
    wallNow: number,
  ): Promise<LiveEngineerStateView[]> {
    const rows = await tx.engineerDay.findMany({
      where: { workDate: day.workDate },
      select: {
        engineerId: true,
        availability: true,
        lunchStartedAt: true,
        lunchDurationSec: true,
      },
    });
    const availability = new Map(rows.map((row) => [row.engineerId, row.availability]));
    const active = await tx.requestFact.findMany({
      where: { kind: 'started', request: { lifecycle: 'in_progress' } },
      select: { engineerId: true, requestId: true },
    });
    const activeByEngineer = new Map(
      active.flatMap((item) =>
        item.engineerId ? [[item.engineerId, item.requestId] as const] : [],
      ),
    );
    const byRequest = new Map(day.requests.map((state) => [state.requestId, state]));
    const liveNow = this.dayState.liveNow(day, wallNow);
    // One plan read for the whole roster. Loading it again per engineer kept the
    // routing lock busy long enough that login, passports and the engineer app timed out.
    const loadedPlan = await this.plans.currentRoster(tx);
    const loadedRoutes = loadedPlan?.routes ?? [];
    return Promise.all(
      day.engineers.map(async (state) => {
        const activeRequestId = activeByEngineer.get(state.engineerId) ?? null;
        const pendingDelay = [...byRequest.values()].find(
          (item) =>
            item.reservedEngineerId === state.engineerId &&
            item.requestId === activeRequestId &&
            item.problemKind === 'delay' &&
            item.problemNote &&
            item.additionalDurationSec,
        );
        const current = await this.routeQuery.currentFor(
          tx,
          day,
          state.engineerId,
          liveNow,
          loadedRoutes,
          loadedPlan?.revision ?? null,
        );
        const replanPending = 'replanPending' in current && current.replanPending === true;
        const lunch = await this.routeQuery.activeLunch(
          tx,
          day.workDate,
          state.engineerId,
          current.route,
          liveNow,
        );
        const routeState =
          day.status === 'finished'
            ? 'exhausted'
            : replanPending
              ? 'awaiting_plan'
              : current.current ||
                  current.route?.stops.some((stop) => stop.kind === 'job' && stop.endAt >= liveNow)
                ? 'active'
                : 'awaiting_plan';
        const canFinishDay = await this.canEngineerFinishDay(tx, day, state, liveNow);
        const lunchDay = rows.find((row) => row.engineerId === state.engineerId);
        return {
          id: state.engineerId,
          name: state.engineer.displayName,
          lineStatus: state.lineStatus,
          lineStartedAt: nullableNumber(state.lineStartedAt),
          noShowAt: nullableNumber(state.noShowAt),
          lunchInterval:
            lunchDay?.lunchStartedAt != null && lunchDay.lunchDurationSec != null
              ? {
                  startAt: Number(lunchDay.lunchStartedAt),
                  endAt: Number(lunchDay.lunchStartedAt) + lunchDay.lunchDurationSec,
                }
              : null,
          availability: availability.get(state.engineerId) ?? 'offline',
          activeRequestId,
          technicalBreak:
            state.technicalBreakStartedAt === null ||
            state.technicalBreakPlannedEndAt === null ||
            state.technicalBreakOverdueAt === null
              ? null
              : {
                  startedAt: Number(state.technicalBreakStartedAt),
                  plannedEndAt: Number(state.technicalBreakPlannedEndAt),
                  overdueAt: Number(state.technicalBreakOverdueAt),
                },
          pendingDelayProblem:
            pendingDelay?.problemNote && pendingDelay.additionalDurationSec
              ? {
                  requestId: pendingDelay.requestId,
                  note: pendingDelay.problemNote,
                  additionalDurationSec: pendingDelay.additionalDurationSec,
                }
              : null,
          routeState,
          canFinishDay,
          progress: await this.readProjection.routeProgress(
            tx,
            state,
            current.route,
            activeRequestId,
            lunch,
            liveNow,
            replanPending,
          ),
          stats: await this.statsFor(tx, day, state.engineerId),
        };
      }),
    );
  }

  /** Personal release never follows an empty route alone or dispatcher alert state. */
  async canEngineerFinishDay(
    tx: Tx,
    day: LiveWorkday,
    state: LiveEngineerState,
    liveNow: number,
  ): Promise<boolean> {
    if (
      await tx.equipmentLogistics.count({
        where: {
          workDate: day.workDate,
          status: { in: ['searching', 'assigned', 'error'] },
          OR: [{ donorEngineerId: state.engineerId }, { receiverEngineerId: state.engineerId }],
        },
      })
    )
      return false;
    const dayStart = Date.parse(`${day.workDate}T00:00:00+03:00`) / 1000;
    if (
      liveNow < dayStart + 17 * 3600 ||
      state.lineStartedAt === null ||
      state.lineStatus !== 'online'
    )
      return false;
    const current = await this.routeQuery.currentFor(tx, day, state.engineerId, liveNow);
    if (
      current.current ||
      ('replanPending' in current && current.replanPending) ||
      (await this.routeQuery.activeLunch(
        tx,
        day.workDate,
        state.engineerId,
        current.route,
        liveNow,
      ))
    )
      return false;
    const plan = await this.plans.current(tx);
    if (!plan) return false;
    const latestOwners = await tx.appliedPlanAssignment.findMany({
      where: {
        status: 'assigned',
        engineerId: { not: null },
        OR: [
          { planId: plan.id },
          { plan: { planAsOf: { gte: BigInt(dayStart), lt: BigInt(dayStart + 86400) } } },
        ],
      },
      orderBy: { plan: { revision: 'desc' } },
      distinct: ['requestId'],
      select: { requestId: true, engineerId: true, status: true },
    });
    const otherOwners = latestOwners
      .filter((item) => item.status === 'assigned' && item.engineerId !== state.engineerId)
      .map((item) => item.requestId);
    // Retain evidence of this engineer's unfinished work even when a broken replan
    // drops its route. The latest witnessed reassignment releases the former owner
    // even if a subsequent broken plan drops the new owner's route too.
    const remaining = await tx.request.count({
      where: {
        id: { notIn: otherOwners },
        lifecycle: { in: ['submitted', 'in_progress'] },
        windowStartAt: { lt: BigInt(dayStart + 86400) },
        windowEndAt: { gte: BigInt(dayStart) },
        liveStates: { none: { workdayId: day.id, assumedCompletedAt: { not: null } } },
        OR: [
          { facts: { some: { engineerId: state.engineerId, kind: 'started' } } },
          { liveStates: { some: { workdayId: day.id, reservedEngineerId: state.engineerId } } },
          {
            assignments: {
              some: {
                engineerId: state.engineerId,
                status: 'assigned',
                plan: { planAsOf: { gte: BigInt(dayStart), lt: BigInt(dayStart + 86400) } },
              },
            },
          },
        ],
      },
    });
    const stats = await this.statsFor(tx, day, state.engineerId);
    return (
      remaining === 0 &&
      stats.completedCount + stats.assumedCompletedCount + stats.cancelledCount > 0
    );
  }

  /** Read-only history overlay; Router's active plan stays an immutable future plan. */
  private async historyView(tx: Tx, day: DayWithStates): Promise<DispatchLiveView['history']> {
    return this.readProjection.historyView(tx, day);
  }

  /** Aggregates role-scoped outcome counters from durable request and LIVE state facts. */
  private async statsFor(
    tx: Tx,
    day: LiveWorkday,
    engineerId?: string,
  ): Promise<LiveWorkdayView['stats']> {
    return this.readProjection.statsFor(tx, day, engineerId);
  }
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
