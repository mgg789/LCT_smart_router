import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { LiveActionDto } from '../../api/dto/live.dto';
import type {
  DispatchLiveView,
  EngineerLiveView,
  LiveEngineerStateView,
  LiveWorkdayView,
} from '../../api/live-view.types';
import { type PlanRouteView, type PlanStopView, toPlanView } from '../../api/plan-view';
import { toRequestView } from '../../api/request-view';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import type {
  Availability,
  Engineer,
  LiveEngineerState,
  LiveRequestState,
  LiveWorkday,
} from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { APP_STATE_KEYS, PrismaService, type Tx, UnitOfWork } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { AppliedPlanService } from '../../routing/router-gateway';
import { EngineersService } from '../engineers';
import { workDateOf } from '../engineers/workday';
import { FactsService } from '../facts';
import {
  ExecutionTimingPolicy,
  type ExecutionTimingPolicyValue,
} from '../facts/execution-timing-policy';

const NO_SHOW_SEC = 30 * 60;
const TECHNICAL_BREAK_SEC = 15 * 60;
const TECHNICAL_BREAK_OVERDUE_SEC = 20 * 60;
const WINDOW_COMPLETION_GRACE_SEC = 10 * 60;
const POST_LUNCH_HANDOFF_GRACE_SEC = 5 * 60;

type DayWithStates = LiveWorkday & {
  engineers: Array<LiveEngineerState & { engineer: Engineer }>;
  requests: LiveRequestState[];
};

/**
 * Persistent LIVE business flow. It maps wall-clock time onto the imported logical
 * timeline without changing auth/session time or the Router contracts. Every automatic
 * transition is a durable state change, so restart and a second API instance resume the
 * same day instead of keeping a process-local stopwatch.
 */
@Injectable()
export class LiveService {
  private advanceInFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
    private readonly engineers: EngineersService,
    private readonly facts: FactsService,
    private readonly timing: ExecutionTimingPolicy,
    private readonly plans: AppliedPlanService,
    private readonly publisher: SnapshotPublisher,
  ) {}

  /** Dispatcher entry: creates the durable pending card but does not start its clock. */
  async dispatchView(): Promise<DispatchLiveView> {
    await this.advanceOnce();
    return this.uow.run(async (tx) => this.dispatchViewIn(tx, this.clock.nowSeconds()));
  }

  /** Starts the pending day exactly once and forces a fresh Router publication at t=0. */
  async start(context: OperationContext): Promise<DispatchLiveView> {
    const pending = await this.ensureDay(context.tx, context.now);
    await context.tx.$queryRaw`SELECT id FROM live_workdays WHERE id = ${pending.id} FOR UPDATE`;
    const day = await context.tx.liveWorkday.findUniqueOrThrow({ where: { id: pending.id } });
    if (day.status === 'pending') {
      await context.tx.liveWorkday.update({
        where: { id: day.id },
        data: {
          status: 'running',
          startedAtWallSec: BigInt(context.now),
          speedDurationSec: this.config.get('speed_up_work_stub'),
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
      await this.ensureEngineerStates(context.tx, day.id, context.now);
      await this.captureRouteOrigins(context.tx, day.id, Number(day.logicalStartAt), context.now);
      // Import may already have published an identical task. Day start is deliberately
      // the sole exception: Router needs a publication stamped with logical t=0.
      await this.publisher.publishIfChanged(
        context.tx,
        Number(day.logicalStartAt),
        PUBLICATION_TRIGGERS.LIVE_WORKDAY_STARTED,
        { force: true, businessTime: true },
      );
    }
    return this.dispatchViewIn(context.tx, context.now);
  }

  /** Engineer entry. A session resolves its own subject in the controller. */
  async engineerView(engineerId: string): Promise<EngineerLiveView> {
    await this.advanceOnce();
    return this.uow.run(async (tx) => this.engineerViewIn(tx, engineerId, this.clock.nowSeconds()));
  }

  /** Legacy mutation endpoints must not bypass LIVE ordering or its business clock. */
  async assertLegacyMutationAllowed(): Promise<void> {
    const running = await this.prisma.liveWorkday.findFirst({
      where: { status: 'running' },
      select: { id: true },
    });
    if (running)
      throw new SysError(
        'VALIDATION_FAILED',
        'LIVE workday is running; use /engineer/live/actions',
      );
  }

  /**
   * Keeps the dashboard-wide lunch switch meaningful for the actual roster.
   * Router's flag selects lunch search, while these daily facts supply its duration and
   * window. A used lunch is never reset by either direction of the switch.
   */
  async synchronizeGlobalLunchSwitch(enabled: boolean): Promise<void> {
    const wallNow = this.clock.nowSeconds();
    await this.uow.run(async (tx) => {
      const day = await this.ensureDay(tx, wallNow);
      const lunch = standardLunchWindow(day.workDate);
      const changed = await tx.engineerDay.updateMany({
        where: { workDate: day.workDate, lunchTaken: false },
        data: enabled
          ? {
              lunchEnabled: true,
              lunchDurationSec: 30 * 60,
              lunchWindowStartAt: BigInt(lunch.startAt),
              lunchWindowEndAt: BigInt(lunch.endAt),
              updatedAt: BigInt(wallNow),
              version: { increment: 1 },
            }
          : {
              lunchEnabled: false,
              lunchDurationSec: null,
              lunchWindowStartAt: null,
              lunchWindowEndAt: null,
              lunchRequired: false,
              updatedAt: BigInt(wallNow),
              version: { increment: 1 },
            },
      });
      if (changed.count > 0) {
        await this.publisher.publishIfChanged(
          tx,
          day.status === 'running' ? this.liveNow(day, wallNow) : wallNow,
          PUBLICATION_TRIGGERS.ENGINEER_WORKDAY_CHANGED,
          { businessTime: day.status === 'running' },
        );
      }
    });
  }

  /** Keeps dispatcher capacity controls on the same LIVE clock and line state. */
  async setDispatcherAvailability(
    context: OperationContext,
    engineerId: string,
    availability: Availability,
    expectedOnlineAt: number | null,
  ) {
    const day = await context.tx.liveWorkday.findFirst({ where: { status: 'running' } });
    if (!day)
      return this.engineers.setAvailability(context, engineerId, availability, expectedOnlineAt);
    if (expectedOnlineAt !== null)
      throw new SysError(
        'VALIDATION_FAILED',
        'Use LIVE technical breaks for return forecasts during a running workday',
      );
    await context.tx.$queryRaw`SELECT id FROM live_workdays WHERE id = ${day.id} FOR UPDATE`;
    const state = await this.requireEngineerState(context.tx, day.id, engineerId, context.now);
    if (state.lineStatus === 'technical_break')
      throw new SysError(
        'VALIDATION_FAILED',
        'The engineer must finish the technical break explicitly',
      );
    const liveNow = this.liveNow(day, context.now);
    await context.tx.liveEngineerState.update({
      where: { id: state.id },
      data: {
        lineStatus:
          availability === 'offline'
            ? 'no_show_offline'
            : state.lineStartedAt === null
              ? 'pending'
              : 'online',
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    return this.engineers.setAvailability(
      { ...context, now: liveNow, businessTime: true },
      engineerId,
      availability,
      expectedOnlineAt,
    );
  }

  /** Applies one engineer-owned action under the virtual business clock. */
  async act(
    context: OperationContext,
    engineerId: string,
    input: LiveActionDto,
  ): Promise<EngineerLiveView> {
    const day = await this.ensureDay(context.tx, context.now);
    if (day.status !== 'running') {
      throw new SysError('VALIDATION_FAILED', 'The dispatcher has not started the workday');
    }
    const liveNow = this.liveNow(day, context.now);
    await this.advanceIn(context.tx, day, context.now, liveNow);
    const state = await this.requireEngineerState(context.tx, day.id, engineerId, context.now);
    const businessContext: OperationContext = { ...context, now: liveNow, businessTime: true };
    if (input.kind !== 'online' && input.kind !== 'break_finish' && state.lineStatus !== 'online') {
      throw SysError.forbidden('Go online before recording LIVE work actions', {
        lineStatus: state.lineStatus,
      });
    }

    switch (input.kind) {
      case 'online':
        if (state.lineStatus === 'technical_break') {
          throw new SysError(
            'VALIDATION_FAILED',
            'Finish the technical break explicitly before going online',
          );
        }
        await this.engineers.setAvailability(businessContext, engineerId, 'online', null);
        await context.tx.liveEngineerState.update({
          where: { id: state.id },
          data: {
            lineStatus: 'online',
            lineStartedAt: BigInt(liveNow),
            technicalBreakStartedAt: null,
            technicalBreakPlannedEndAt: null,
            technicalBreakOverdueAt: null,
            updatedAt: BigInt(context.now),
            version: { increment: 1 },
          },
        });
        break;

      case 'on_time':
      case 'eta': {
        const current = await this.currentFor(context.tx, day, engineerId, liveNow);
        this.assertCurrentRequest(current, input.requestId);
        // Once the customer window is open the UI offers an early start *alongside*
        // the ETA controls until the planned service slot begins.
        const forecastOpen =
          current.phase === 'awaiting_window' ||
          (current.phase === 'ready_to_start' &&
            current.stop !== null &&
            liveNow < current.stop.startAt);
        if (!forecastOpen) {
          throw new SysError(
            'VALIDATION_FAILED',
            'Arrival forecast is available only before the visit window',
          );
        }
        const reportedEtaAt =
          input.kind === 'eta' ? input.etaAt : (current.stop?.startAt ?? liveNow);
        if (
          reportedEtaAt < Math.max(liveNow, current.stop?.startAt ?? liveNow) ||
          reportedEtaAt > Number(day.logicalEndAt)
        ) {
          throw new SysError('VALIDATION_FAILED', 'ETA must be within the remaining workday', {
            details: { etaAt: reportedEtaAt },
          });
        }
        const request = current.current?.request;
        if (!request) throw SysError.notFound('Request', { requestId: input.requestId });
        // Forecasts are promises about a completed visit. A late start whose normative
        // service would already exceed the customer window plus the product grace must
        // be released back to the Router instead of pinning a knowingly futile drive.
        if (
          reportedEtaAt + request.serviceDurationSec >
          request.windowEndAt + WINDOW_COMPLETION_GRACE_SEC
        ) {
          await this.releaseInfeasibleReservation(
            context.tx,
            day,
            engineerId,
            request.id,
            reportedEtaAt,
            context.now,
          );
          await this.publisher.publishIfChanged(
            context.tx,
            liveNow,
            PUBLICATION_TRIGGERS.ENGINEER_FORECAST_CHANGED,
            { businessTime: true },
          );
          return this.engineerViewIn(context.tx, engineerId, context.now);
        }
        await this.upsertRequestState(context.tx, day.id, input.requestId, context.now, {
          reportedEtaAt: BigInt(reportedEtaAt),
          reservedEngineerId: engineerId,
        });
        if (input.kind === 'eta') {
          await this.publisher.publishIfChanged(
            context.tx,
            liveNow,
            PUBLICATION_TRIGGERS.ENGINEER_FORECAST_CHANGED,
            { businessTime: true },
          );
        }
        break;
      }

      case 'start': {
        const current = await this.currentFor(context.tx, day, engineerId, liveNow);
        this.assertCurrentRequest(current, input.requestId);
        if (current.phase !== 'ready_to_start') {
          throw new SysError('VALIDATION_FAILED', 'This visit is not ready to start yet');
        }
        await this.facts.record(
          businessContext,
          engineerId,
          input.requestId,
          'started',
          liveNow,
          null,
          this.timing.current(),
        );
        await this.upsertRequestState(context.tx, day.id, input.requestId, context.now, {
          reservedEngineerId: engineerId,
        });
        await context.tx.liveEngineerState.update({
          where: { id: state.id },
          data: {
            routeAnchorRequestId: input.requestId,
            routeAnchorReachedAt: BigInt(liveNow),
            routeAnchorDepartedAt: null,
            activeLunchLat: null,
            activeLunchLon: null,
            activeLunchStartedAt: null,
            updatedAt: BigInt(context.now),
            version: { increment: 1 },
          },
        });
        break;
      }

      case 'finish': {
        await this.facts.record(
          businessContext,
          engineerId,
          input.requestId,
          'finished',
          liveNow,
          null,
          this.timing.current(),
        );
        await this.departAnchor(context.tx, state, input.requestId, liveNow, context.now);
        break;
      }

      case 'problem':
        await this.problem(businessContext, day, state, engineerId, input);
        break;

      case 'break_start':
        await this.startBreak(businessContext, state, engineerId);
        break;

      case 'break_finish':
        await this.finishBreak(businessContext, state, engineerId);
        break;
    }
    return this.engineerViewIn(context.tx, engineerId, context.now);
  }

  /** Invoked by the coordinator and reads. It is safe to call concurrently. */
  advanceOnce(): Promise<void> {
    if (this.advanceInFlight) return this.advanceInFlight;
    const pending = this.advanceShared().finally(() => {
      if (this.advanceInFlight === pending) this.advanceInFlight = null;
    });
    this.advanceInFlight = pending;
    return pending;
  }

  private async advanceShared(): Promise<void> {
    const wallNow = this.clock.nowSeconds();
    const timing = await this.timing.read();
    await this.uow.run(async (tx) => {
      const generationRow = await tx.appState.findUnique({
        where: { key: APP_STATE_KEYS.GENERATION },
      });
      const generation = typeof generationRow?.value === 'number' ? generationRow.value : 1;
      // A reset/import generation is a hard data boundary.  A stale row must never
      // advance or create state for the new roster even if an interrupted reset left it.
      const days = await tx.liveWorkday.findMany({ where: { generation, status: 'running' } });
      for (const day of days) {
        await this.advanceIn(tx, day, wallNow, this.liveNow(day, wallNow), timing);
      }
    });
  }

  private async dispatchViewIn(tx: Tx, wallNow: number): Promise<DispatchLiveView> {
    const day = await this.ensureDay(tx, wallNow);
    await this.ensureEngineerStates(tx, day.id, wallNow);
    const full = await this.dayWithStates(tx, day.id);
    const requestCount = await tx.request.count({
      where: { lifecycle: { in: ['submitted', 'in_progress'] } },
    });
    return {
      workday: await this.toWorkdayView(tx, full, wallNow, requestCount),
      engineers: await this.engineerStatesView(tx, full, wallNow),
      breaks: await this.breakHistory(tx, full),
      history: await this.historyView(tx, full),
    };
  }

  private async breakHistory(tx: Tx, day: LiveWorkday): Promise<DispatchLiveView['breaks']> {
    if (day.startedAtWallSec === null) return [];
    const rows = await tx.operation.findMany({
      where: {
        state: 'applied',
        action: { in: ['live.engineer.break_start', 'live.engineer.break_finish'] },
        createdAt: { gte: day.startedAtWallSec },
      },
      orderBy: { createdAt: 'asc' },
      select: { operationId: true, action: true, response: true },
    });
    const schema = z.object({
      value: z.object({
        workday: z.object({ id: z.string(), liveNow: z.number() }),
        engineer: z.object({
          id: z.string(),
          technicalBreak: z.object({ startedAt: z.number(), plannedEndAt: z.number() }).nullable(),
        }),
      }),
    });
    const events = rows.flatMap((row) => {
      const parsed = schema.safeParse(row.response);
      return parsed.success && parsed.data.value.workday.id === day.id
        ? [{ ...row, value: parsed.data.value }]
        : [];
    });
    return events.flatMap((event) => {
      const stop = event.value.engineer.technicalBreak;
      if (event.action !== 'live.engineer.break_start' || !stop) return [];
      const finish = events
        .filter(
          (other) =>
            other.action === 'live.engineer.break_finish' &&
            other.value.engineer.id === event.value.engineer.id &&
            other.value.workday.liveNow >= stop.startedAt,
        )
        .sort((a, b) => a.value.workday.liveNow - b.value.workday.liveNow)[0];
      return [
        {
          id: event.operationId,
          engineerId: event.value.engineer.id,
          ...stop,
          endedAt: finish?.value.workday.liveNow ?? null,
        },
      ];
    });
  }

  private async engineerViewIn(
    tx: Tx,
    engineerId: string,
    wallNow: number,
  ): Promise<EngineerLiveView> {
    const day = await this.ensureDay(tx, wallNow);
    await this.requireEngineerState(tx, day.id, engineerId, wallNow);
    const full = await this.dayWithStates(tx, day.id);
    const liveNow = this.liveNow(full, wallNow);
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
    const current = await this.currentFor(tx, full, engineerId, liveNow);
    const lunch = await this.activeLunch(tx, full.workDate, engineerId, current.route, liveNow);
    return {
      workday: await this.toWorkdayView(
        tx,
        full,
        wallNow,
        await tx.request.count({ where: { lifecycle: { in: ['submitted', 'in_progress'] } } }),
      ),
      engineer,
      route: current.route,
      current: current.current,
      lunch,
    };
  }

  private async ensureDay(tx: Tx, wallNow: number): Promise<LiveWorkday> {
    const generationRow = await tx.appState.findUnique({
      where: { key: APP_STATE_KEYS.GENERATION },
    });
    const generation = typeof generationRow?.value === 'number' ? generationRow.value : 1;
    // A fast demo may cross real midnight while its logical day is still running. The
    // durable running row wins over a calendar-derived new pending card.
    const running = await tx.liveWorkday.findFirst({
      where: { generation, status: 'running' },
      orderBy: { startedAtWallSec: 'desc' },
    });
    if (running) return running;
    const workDate = workDateOf(wallNow, this.config.get('APP_TIME_ZONE'));
    const existing = await tx.liveWorkday.findUnique({
      where: { generation_workDate: { generation, workDate } },
    });

    const [days, requests] = await Promise.all([
      tx.engineerDay.findMany({
        where: { workDate },
        select: { shiftStartAt: true, shiftEndAt: true },
      }),
      tx.request.findMany({
        where: { lifecycle: 'submitted', windowEndAt: { gte: BigInt(wallNow - 24 * 3600) } },
        select: { windowStartAt: true, windowEndAt: true },
      }),
    ]);
    const starts = [
      ...days.flatMap((item) => (item.shiftStartAt === null ? [] : [Number(item.shiftStartAt)])),
      ...requests.map((item) => Number(item.windowStartAt)),
    ].filter((value) => Number.isSafeInteger(value));
    const ends = [
      ...days.flatMap((item) => (item.shiftEndAt === null ? [] : [Number(item.shiftEndAt)])),
      ...requests.map((item) => Number(item.windowEndAt)),
    ].filter((value) => Number.isSafeInteger(value));
    const logicalStartAt = starts.length > 0 ? Math.min(...starts) : wallNow;
    const logicalEndAt = Math.max(
      logicalStartAt + 1,
      ...(ends.length > 0 ? ends : [logicalStartAt + 8 * 3600]),
    );
    if (existing) {
      // An import or profile change before the dispatcher presses Start may alter the
      // demonstration horizon. Refresh only a pending card; once started its clock is
      // immutable and survives restarts exactly.
      if (
        existing.status === 'pending' &&
        (Number(existing.logicalStartAt) !== logicalStartAt ||
          Number(existing.logicalEndAt) !== logicalEndAt)
      ) {
        return tx.liveWorkday.update({
          where: { id: existing.id },
          data: {
            logicalStartAt: BigInt(logicalStartAt),
            logicalEndAt: BigInt(logicalEndAt),
            updatedAt: BigInt(wallNow),
            version: { increment: 1 },
          },
        });
      }
      return existing;
    }
    return tx.liveWorkday.upsert({
      where: { generation_workDate: { generation, workDate } },
      update: {},
      create: {
        generation,
        workDate,
        logicalStartAt: BigInt(logicalStartAt),
        logicalEndAt: BigInt(logicalEndAt),
        createdAt: BigInt(wallNow),
        updatedAt: BigInt(wallNow),
      },
    });
  }

  private async ensureEngineerStates(tx: Tx, workdayId: string, wallNow: number): Promise<void> {
    const workday = await tx.liveWorkday.findUniqueOrThrow({ where: { id: workdayId } });
    const days = await tx.engineerDay.findMany({
      where: { workDate: workday.workDate, engineer: { archivedAt: null } },
      select: { engineerId: true },
    });
    if (days.length === 0) return;
    // Every LIVE read calls this guard. One idempotent insert keeps the hot polling path
    // constant-round-trip instead of issuing one upsert per engineer every two seconds.
    await tx.liveEngineerState.createMany({
      data: days.map((day) => ({
        workdayId,
        engineerId: day.engineerId,
        createdAt: BigInt(wallNow),
        updatedAt: BigInt(wallNow),
      })),
      skipDuplicates: true,
    });
  }

  /**
   * Persists the depot vertex that started this LIVE day.
   *
   * The accepted Router plan is allowed to be replaced during the day; using its current
   * route start for the UI cursor made the historical beginning of the route jump after
   * a replan. The first accepted route is therefore copied exactly once into LIVE state.
   */
  private async captureRouteOrigins(
    tx: Tx,
    workdayId: string,
    logicalStartAt: number,
    wallNow: number,
  ): Promise<void> {
    const plan = await this.plans.current(tx);
    if (!plan) return;
    const routes = new Map(toPlanView(plan).routes.map((route) => [route.engineerId, route]));
    const states = await tx.liveEngineerState.findMany({
      where: {
        workdayId,
        OR: [{ routeOriginLat: null }, { routeOriginLon: null }, { routeOriginAt: null }],
      },
    });
    for (const state of states) {
      const route = routes.get(state.engineerId);
      if (!route || route.startLat === undefined || route.startLon === undefined) continue;
      await tx.liveEngineerState.update({
        where: { id: state.id },
        data: {
          routeOriginLat: route.startLat,
          routeOriginLon: route.startLon,
          routeOriginAt: BigInt(route.startAt ?? logicalStartAt),
          updatedAt: BigInt(wallNow),
          version: { increment: 1 },
        },
      });
    }
  }

  private async requireEngineerState(
    tx: Tx,
    workdayId: string,
    engineerId: string,
    wallNow: number,
  ) {
    await this.ensureEngineerStates(tx, workdayId, wallNow);
    const state = await tx.liveEngineerState.findUnique({
      where: { workdayId_engineerId: { workdayId, engineerId } },
    });
    if (!state) throw SysError.notFound('Engineer', { engineerId });
    return state;
  }

  private async dayWithStates(tx: Tx, id: string): Promise<DayWithStates> {
    return tx.liveWorkday.findUniqueOrThrow({
      where: { id },
      include: {
        engineers: { include: { engineer: true }, orderBy: { engineer: { inputOrder: 'asc' } } },
        requests: true,
      },
    });
  }

  private liveNow(
    day: Pick<
      LiveWorkday,
      | 'status'
      | 'logicalStartAt'
      | 'logicalEndAt'
      | 'startedAtWallSec'
      | 'speedDurationSec'
      | 'finishedAt'
    >,
    wallNow: number,
  ): number {
    const start = Number(day.logicalStartAt);
    if (day.status === 'finished')
      return nullableNumber(day.finishedAt) ?? Number(day.logicalEndAt);
    if (day.status !== 'running' || day.startedAtWallSec === null) return start;
    const duration = Math.max(1, Number(day.logicalEndAt) - start);
    const elapsedWall = Math.max(0, wallNow - Number(day.startedAtWallSec));
    const elapsedLogical =
      day.speedDurationSec === null
        ? elapsedWall
        : Math.floor((elapsedWall * duration) / day.speedDurationSec);
    // End-of-shift stops cannot be newly scheduled, but an explicit in-progress visit
    // or technical break must still be finishable afterwards.  Keep its business clock
    // advancing instead of freezing the action surface at logicalEndAt.
    return start + elapsedLogical;
  }

  private async toWorkdayView(
    tx: Tx,
    day: LiveWorkday,
    wallNow: number,
    requestCount: number,
  ): Promise<LiveWorkdayView> {
    const duration = Math.max(1, Number(day.logicalEndAt) - Number(day.logicalStartAt));
    return {
      id: day.id,
      status: day.status,
      workDate: day.workDate,
      logicalStartAt: Number(day.logicalStartAt),
      logicalEndAt: Number(day.logicalEndAt),
      startedAtWallSec: nullableNumber(day.startedAtWallSec),
      finishedAt: nullableNumber(day.finishedAt),
      completionReason:
        day.completionReason === 'schedule_exhausted' || day.completionReason === 'logical_end'
          ? day.completionReason
          : null,
      liveNow: this.liveNow(day, wallNow),
      speedDurationSec: day.speedDurationSec,
      speedFactor: day.speedDurationSec === null ? 1 : duration / day.speedDurationSec,
      engineerStartDeadlineAt: Number(day.logicalStartAt) + NO_SHOW_SEC,
      requestCount,
      stats: await this.statsFor(tx, day),
    };
  }

  private async engineerStatesView(
    tx: Tx,
    day: DayWithStates,
    wallNow: number,
  ): Promise<LiveEngineerStateView[]> {
    const rows = await tx.engineerDay.findMany({
      where: { workDate: day.workDate },
      select: { engineerId: true, availability: true },
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
    const liveNow = this.liveNow(day, wallNow);
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
        const current = await this.currentFor(tx, day, state.engineerId, liveNow);
        const replanPending = 'replanPending' in current && current.replanPending === true;
        const lunch = await this.activeLunch(
          tx,
          day.workDate,
          state.engineerId,
          current.route,
          liveNow,
        );
        const viableDemand = await this.hasViableDemand(tx, day.id, liveNow);
        const routeState =
          day.status === 'finished'
            ? 'exhausted'
            : replanPending
              ? 'awaiting_plan'
              : current.current ||
                  current.route?.stops.some((stop) => stop.kind === 'job' && stop.endAt >= liveNow)
                ? 'active'
                : viableDemand
                  ? 'awaiting_plan'
                  : 'exhausted';
        return {
          id: state.engineerId,
          name: state.engineer.displayName,
          lineStatus: state.lineStatus,
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
          progress: await this.routeProgress(
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

  /** Read-only history overlay; Router's active plan stays an immutable future plan. */
  private async historyView(tx: Tx, day: DayWithStates): Promise<DispatchLiveView['history']> {
    const rows = await tx.request.findMany({
      where: {
        OR: [
          { lifecycle: 'completed' },
          { lifecycle: 'cancelled' },
          { liveStates: { some: { workdayId: day.id, assumedCompletedAt: { not: null } } } },
        ],
      },
      orderBy: { arrivalOrder: 'asc' },
    });
    const live = new Map(day.requests.map((item) => [item.requestId, item]));
    return Promise.all(
      rows.map(async (request) => {
        const assignment = await tx.appliedPlanAssignment.findFirst({
          where: { requestId: request.id },
          orderBy: { plan: { revision: 'desc' } },
        });
        const stopRow = assignment
          ? await tx.appliedPlanStop.findFirst({
              where: { requestId: request.id, route: { planId: assignment.planId } },
            })
          : null;
        const stop = stopRow
          ? {
              sequence: stopRow.sequence,
              kind: stopRow.kind,
              requestId: stopRow.requestId,
              lat: stopRow.lat,
              lon: stopRow.lon,
              arrivalAt: Number(stopRow.arrivalAt),
              startAt: Number(stopRow.startAt),
              endAt: Number(stopRow.endAt),
            }
          : null;
        const state = live.get(request.id) ?? null;
        return {
          request: toRequestView(request, state),
          engineerId: assignment?.engineerId ?? null,
          stop,
          outcome:
            state?.assumedCompletedAt !== null && state !== null
              ? ('assumed_completed' as const)
              : request.lifecycle === 'cancelled'
                ? ('cancelled' as const)
                : ('completed' as const),
          terminalAt:
            nullableNumber(state?.assumedCompletedAt ?? null) ??
            nullableNumber(request.cancelledAt) ??
            nullableNumber(request.completedAt) ??
            nullableNumber(request.updatedAt) ??
            Number(day.logicalStartAt),
        };
      }),
    );
  }

  /** Returns only demand that can still finish inside the LIVE ten-minute window grace. */
  private async hasViableDemand(tx: Tx, workdayId: string, liveNow: number): Promise<boolean> {
    const candidates = await tx.request.findMany({
      where: {
        lifecycle: 'submitted',
        windowEndAt: { gte: BigInt(liveNow - WINDOW_COMPLETION_GRACE_SEC) },
        liveStates: {
          none: { workdayId, assumedCompletedAt: { not: null } },
        },
      },
      select: { windowEndAt: true, serviceDurationSec: true },
    });
    return candidates.some(
      (candidate) =>
        liveNow + candidate.serviceDurationSec <=
        Number(candidate.windowEndAt) + WINDOW_COMPLETION_GRACE_SEC,
    );
  }

  /** Aggregates role-scoped outcome counters from durable request and LIVE state facts. */
  private async statsFor(
    tx: Tx,
    day: LiveWorkday,
    engineerId?: string,
  ): Promise<LiveWorkdayView['stats']> {
    const states = await tx.liveRequestState.findMany({
      where: {
        workdayId: day.id,
        ...(engineerId ? { reservedEngineerId: engineerId } : {}),
      },
      select: { requestId: true, assumedCompletedAt: true, problemKind: true },
    });
    const requestIds = states.map((state) => state.requestId);
    const [completedCount, cancelledCount, technicalBreakCount] = await Promise.all([
      requestIds.length === 0
        ? 0
        : tx.request.count({ where: { id: { in: requestIds }, lifecycle: 'completed' } }),
      requestIds.length === 0
        ? 0
        : tx.request.count({ where: { id: { in: requestIds }, lifecycle: 'cancelled' } }),
      engineerId
        ? tx.operation.count({
            where: {
              state: 'applied',
              action: 'live.engineer.break_start',
              targetRef: engineerId,
              createdAt: { gte: day.startedAtWallSec ?? BigInt(0) },
            },
          })
        : tx.operation.count({
            where: {
              state: 'applied',
              action: 'live.engineer.break_start',
              createdAt: { gte: day.startedAtWallSec ?? BigInt(0) },
            },
          }),
    ]);
    return {
      completedCount,
      cancelledCount,
      assumedCompletedCount: states.filter((state) => state.assumedCompletedAt !== null).length,
      problemCount: states.filter((state) => state.problemKind !== null).length,
      technicalBreakCount,
    };
  }

  /** Projects the factual graph cursor without allowing a fresh Router revision to move it. */
  private async routeProgress(
    tx: Tx,
    state: LiveEngineerState,
    route: PlanRouteView | null,
    activeRequestId: string | null,
    lunch: { startedAt: number; endAt: number } | null,
    liveNow: number,
    suppressNext: boolean,
  ): Promise<LiveEngineerStateView['progress']> {
    const pointFor = async (requestId: string | null) => {
      if (requestId) {
        const request = await tx.request.findUnique({
          where: { id: requestId },
          select: { lat: true, lon: true },
        });
        if (request !== null && request.lat !== null && request.lon !== null) {
          return { kind: 'job' as const, requestId, lat: request.lat, lon: request.lon };
        }
      }
      return null;
    };
    const originBase =
      state.routeOriginLat !== null && state.routeOriginLon !== null
        ? {
            kind: 'start' as const,
            requestId: null,
            lat: state.routeOriginLat,
            lon: state.routeOriginLon,
          }
        : route?.startLat !== undefined && route.startLon !== undefined
          ? {
              kind: 'start' as const,
              requestId: null,
              lat: route.startLat,
              lon: route.startLon,
            }
          : null;
    if (!originBase) return null;
    const origin = {
      ...originBase,
      at: nullableNumber(state.routeOriginAt) ?? route?.startAt ?? liveNow,
    };
    const anchorBase = (await pointFor(state.routeAnchorRequestId)) ?? originBase;
    const anchor = {
      ...anchorBase,
      at: nullableNumber(state.routeAnchorReachedAt) ?? origin.at,
    };
    const routeJobs = (suppressNext ? [] : (route?.stops ?? [])).filter(
      (stop): stop is PlanStopView & { requestId: string } =>
        stop.kind === 'job' && stop.requestId !== null,
    );
    const anchorSequence = routeJobs.find(
      (stop) => stop.requestId === state.routeAnchorRequestId,
    )?.sequence;
    const possibleNext = routeJobs.filter(
      (stop) => anchorSequence === undefined || stop.sequence > anchorSequence,
    );
    const possibleIds = possibleNext.map((stop) => stop.requestId);
    const viableNext = await tx.request.findMany({
      where: {
        id: { in: possibleIds },
        lifecycle: 'submitted',
        liveStates: {
          none: { workdayId: state.workdayId, assumedCompletedAt: { not: null } },
        },
      },
      select: { id: true },
    });
    const viableIds = new Set(viableNext.map((request) => request.id));
    // The graph cursor moves forward from its durable anchor. Looking for merely a
    // different id can select an already traversed stop that appears earlier in the
    // immutable accepted plan.
    const nextStop = possibleNext.find((stop) => viableIds.has(stop.requestId));
    const next = nextStop?.requestId
      ? {
          kind: 'job' as const,
          requestId: nextStop.requestId,
          lat: nextStop.lat,
          lon: nextStop.lon,
          at: nextStop.startAt,
        }
      : null;
    // Lunch is a structural part of the traversed edge as soon as the preceding job is
    // left. It is not a waiting vertex: the UI must highlight job→lunch→next before the
    // clock enters the break, and keep that compound edge until the next job is reached.
    const structuralLunch =
      state.routeAnchorDepartedAt === null || activeRequestId !== null || nextStop === undefined
        ? null
        : (route?.stops.find(
            (stop) =>
              stop.kind === 'lunch' &&
              stop.sequence < nextStop.sequence &&
              (anchorSequence === undefined || stop.sequence > anchorSequence),
          ) ?? null);
    const persistedLunch =
      state.activeLunchLat !== null &&
      state.activeLunchLon !== null &&
      state.activeLunchStartedAt !== null
        ? {
            kind: 'lunch' as const,
            requestId: null,
            lat: state.activeLunchLat,
            lon: state.activeLunchLon,
            at: Number(state.activeLunchStartedAt),
          }
        : null;
    if (lunch || persistedLunch || structuralLunch) {
      const lunchStop = route?.stops.find(
        (stop) =>
          stop.kind === 'lunch' &&
          (lunch
            ? stop.startAt <= lunch.startedAt && lunch.startedAt < stop.endAt
            : persistedLunch !== null
              ? stop.lat === persistedLunch.lat && stop.lon === persistedLunch.lon
              : stop === structuralLunch),
      );
      const lunchPoint = lunchStop
        ? {
            kind: 'lunch' as const,
            requestId: null,
            lat: lunchStop.lat,
            lon: lunchStop.lon,
            at: lunchStop.startAt,
          }
        : (persistedLunch ??
          (structuralLunch
            ? {
                kind: 'lunch' as const,
                requestId: null,
                lat: structuralLunch.lat,
                lon: structuralLunch.lon,
                at: structuralLunch.startAt,
              }
            : null));
      const afterLunch = possibleNext.find(
        (stop) => viableIds.has(stop.requestId) && (!lunch || stop.startAt >= lunch.endAt),
      );
      return {
        phase: lunch ? 'lunch' : 'traveling',
        origin,
        anchor,
        lunch: lunchPoint,
        next: afterLunch?.requestId
          ? {
              kind: 'job',
              requestId: afterLunch.requestId,
              lat: afterLunch.lat,
              lon: afterLunch.lon,
              at: afterLunch.startAt,
            }
          : next,
        occurredAt:
          lunch?.startedAt ??
          Number(state.routeAnchorDepartedAt ?? state.activeLunchStartedAt ?? BigInt(liveNow)),
      };
    }
    if (activeRequestId) {
      const active = await pointFor(activeRequestId);
      if (active) {
        const reachedAt = nullableNumber(state.routeAnchorReachedAt) ?? liveNow;
        return {
          phase: 'on_site',
          origin,
          anchor: { ...active, at: reachedAt },
          lunch: null,
          next,
          occurredAt: reachedAt,
        };
      }
    }
    if (state.routeAnchorDepartedAt !== null) {
      return {
        phase: 'traveling',
        origin,
        anchor,
        lunch: null,
        next,
        occurredAt: Number(state.routeAnchorDepartedAt),
      };
    }
    return {
      // Going online is a factual departure from the depot. The start marker remains
      // only as the origin of the highlighted first edge until the first explicit or
      // silent job start reaches its vertex.
      phase: state.lineStartedAt === null ? 'not_started' : 'traveling',
      origin,
      anchor,
      lunch: null,
      next,
      occurredAt:
        nullableNumber(state.routeAnchorReachedAt) ??
        nullableNumber(state.lineStartedAt) ??
        liveNow,
    };
  }

  private async currentFor(
    tx: Tx,
    day: DayWithStates | LiveWorkday,
    engineerId: string,
    liveNow: number,
  ) {
    const plan = await this.plans.current(tx);
    let route = plan
      ? (toPlanView(plan).routes.find((item) => item.engineerId === engineerId) ?? null)
      : null;
    const stateRows =
      'requests' in day
        ? day.requests
        : await tx.liveRequestState.findMany({ where: { workdayId: day.id } });
    const assumed = new Set(
      stateRows.filter((item) => item.assumedCompletedAt !== null).map((item) => item.requestId),
    );
    const liveByRequest = new Map(stateRows.map((item) => [item.requestId, item]));
    const active = await tx.request.findFirst({
      where: { lifecycle: 'in_progress', facts: { some: { engineerId, kind: 'started' } } },
      orderBy: { startedAt: 'desc' },
    });
    if (active) {
      const startedAt = Number(active.startedAt);
      const stop: PlanStopView | null =
        route?.stops.find((item) => item.requestId === active.id) ??
        (active.lat !== null && active.lon !== null
          ? {
              sequence: 0,
              kind: 'job',
              requestId: active.id,
              lat: active.lat,
              lon: active.lon,
              arrivalAt: startedAt,
              startAt: startedAt,
              endAt: Number(
                active.expectedCompletionAt ?? BigInt(startedAt + active.serviceDurationSec),
              ),
            }
          : null);
      if (stop && !route?.stops.some((item) => item.requestId === active.id)) {
        route = route
          ? { ...route, stops: [stop, ...route.stops] }
          : {
              engineerId,
              startLat: stop.lat,
              startLon: stop.lon,
              startAt: stop.startAt,
              finishAt: stop.endAt,
              distanceKm: 0,
              travelTimeSec: 0,
              workTimeSec: active.serviceDurationSec,
              waitingTimeSec: 0,
              lunchTimeSec: 0,
              assignedCount: 1,
              lunchStatus: 'none',
              legs: [],
              stops: [stop],
            };
      }
      return {
        route,
        stop,
        phase: 'in_progress' as const,
        current: {
          request: toRequestView(active, liveByRequest.get(active.id) ?? null),
          stop,
          phase: 'in_progress' as const,
          expectedCompletionAt: nullableNumber(active.expectedCompletionAt),
          overrunAt: nullableNumber(active.overrunDetectedAt),
        },
      };
    }
    // Lunch is a non-interactive blocking interval. Returning no current job makes all
    // staged actions refuse through the same server-side current-request guard.
    if (await this.activeLunch(tx, day.workDate, engineerId, route, liveNow))
      return { route, stop: null, phase: null, current: null };
    const replanPending = stateRows.some(
      (item) =>
        item.replanPendingEngineerId === engineerId &&
        item.replanPendingPlanRevision !== null &&
        item.replanPendingPlanRevision === plan?.revision,
    );
    if (replanPending) {
      return { route, stop: null, phase: null, current: null, replanPending: true as const };
    }
    const reserved = await tx.liveRequestState.findFirst({
      where: {
        workdayId: day.id,
        reservedEngineerId: engineerId,
        assumedCompletedAt: null,
        request: { lifecycle: 'submitted' },
        OR: [{ reportedEtaAt: { not: null } }, { assumedStartedAt: { not: null } }],
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (reserved) {
      const request = await tx.request.findUnique({ where: { id: reserved.requestId } });
      if (request?.lifecycle === 'submitted') {
        if (request.lat === null || request.lon === null) {
          // A reservation can only be projected when the request remains routable.
          // Do not invent a location merely to keep a stale card interactive.
          return { route, stop: null, phase: null, current: null };
        }
        const reservedAt = reserved.reportedEtaAt ?? reserved.assumedStartedAt;
        if (reservedAt === null) throw new Error('A reserved visit requires a start forecast');
        const plannedAt = Number(reservedAt);
        const stop: PlanStopView = {
          sequence: 0,
          kind: 'job',
          requestId: request.id,
          lat: request.lat,
          lon: request.lon,
          arrivalAt: plannedAt,
          startAt: plannedAt,
          endAt: plannedAt + request.serviceDurationSec,
        };
        // Router deliberately omits the pinned reservation from its remaining input.
        // The engineer still needs to see the acknowledged visit, therefore the LIVE
        // projection overlays it locally without changing the applied solver route.
        if (route) {
          const withoutPinned = route.stops.filter((item) => item.requestId !== request.id);
          route = {
            ...route,
            assignedCount: route.assignedCount + 1,
            workTimeSec: route.workTimeSec + request.serviceDurationSec,
            stops: [stop, ...withoutPinned]
              .sort((a, b) => a.startAt - b.startAt)
              .map((item, index) => ({ ...item, sequence: index })),
          };
        } else {
          route = {
            engineerId,
            startLat: request.lat,
            startLon: request.lon,
            startAt: plannedAt,
            finishAt: stop.endAt,
            distanceKm: 0,
            travelTimeSec: 0,
            workTimeSec: request.serviceDurationSec,
            waitingTimeSec: 0,
            lunchTimeSec: 0,
            assignedCount: 1,
            lunchStatus: 'none',
            legs: [],
            stops: [stop],
          };
        }
        const phase =
          liveNow < plannedAt && liveNow < request.windowStartAt
            ? ('awaiting_window' as const)
            : ('ready_to_start' as const);
        return {
          route,
          stop,
          phase,
          current: {
            request: toRequestView(request, reserved),
            stop,
            phase,
            expectedCompletionAt: null,
            overrunAt: null,
          },
        };
      }
    }
    const stops = (route?.stops ?? []).filter(
      (stop) =>
        stop.kind === 'job' &&
        stop.requestId &&
        !assumed.has(stop.requestId) &&
        stop.endAt >= liveNow,
    );
    const requestIds = stops.flatMap((stop) => (stop.requestId ? [stop.requestId] : []));
    const requests = await tx.request.findMany({
      where: { id: { in: requestIds }, lifecycle: 'submitted' },
    });
    const requestsById = new Map(requests.map((request) => [request.id, request]));
    // An applied plan is immutable history until Router accepts its replacement. A
    // completed or cancelled first stop must therefore be skipped locally instead of
    // hiding every still-submitted stop that follows it.
    const stop = stops.find((item) => item.requestId && requestsById.has(item.requestId)) ?? null;
    const request = stop?.requestId ? (requestsById.get(stop.requestId) ?? null) : null;
    if (!stop || !request) return { route, stop: null, phase: null, current: null };
    // The published route may reserve a later service slot, but arriving after the
    // customer window has opened is enough to let the engineer start early.
    const phase =
      liveNow < stop.startAt && liveNow < Number(request.windowStartAt)
        ? ('awaiting_window' as const)
        : ('ready_to_start' as const);
    return {
      route,
      stop,
      phase,
      current: {
        request: toRequestView(request, liveByRequest.get(request.id) ?? null),
        stop,
        phase,
        expectedCompletionAt: null,
        overrunAt: null,
      },
    };
  }

  private lunchAt(
    route: PlanRouteView | null,
    liveNow: number,
  ): { startedAt: number; endAt: number } | null {
    const lunch = route?.stops.find(
      (stop) => stop.kind === 'lunch' && stop.startAt <= liveNow && liveNow < stop.endAt,
    );
    return lunch ? { startedAt: lunch.startAt, endAt: lunch.endAt } : null;
  }

  /** Keeps an entered automatic lunch blocking after a remaining-day plan omits it. */
  private async activeLunch(
    tx: Tx,
    workDate: string,
    engineerId: string,
    route: PlanRouteView | null,
    liveNow: number,
  ) {
    const day = await tx.engineerDay.findUnique({
      where: { engineerId_workDate: { engineerId, workDate } },
    });
    const planned = this.lunchAt(route, liveNow);
    // The accepted plan can lag behind a dispatcher switch. The current day fact is
    // authoritative until Router returns a plan without the removed lunch stop.
    if (day?.lunchEnabled && planned) return planned;
    if (!day?.lunchTaken || day.lunchStartedAt === null || !day.lunchDurationSec) return null;
    const startedAt = Number(day.lunchStartedAt);
    const endAt = startedAt + day.lunchDurationSec;
    return startedAt <= liveNow && liveNow < endAt ? { startedAt, endAt } : null;
  }

  private assertCurrentRequest(
    current: Awaited<ReturnType<LiveService['currentFor']>>,
    requestId: string,
  ): void {
    if (!current.current || current.current.request.id !== requestId) {
      throw SysError.forbidden('Only the nearest current visit may be updated', { requestId });
    }
  }

  private async upsertRequestState(
    tx: Tx,
    workdayId: string,
    requestId: string,
    wallNow: number,
    data: Record<string, unknown>,
  ) {
    return tx.liveRequestState.upsert({
      where: { workdayId_requestId: { workdayId, requestId } },
      update: { ...data, updatedAt: BigInt(wallNow), version: { increment: 1 } },
      create: {
        workdayId,
        requestId,
        ...data,
        createdAt: BigInt(wallNow),
        updatedAt: BigInt(wallNow),
      },
    });
  }

  /** Releases an ETA that cannot finish before the window's LIVE completion grace. */
  private async releaseInfeasibleReservation(
    tx: Tx,
    day: LiveWorkday,
    engineerId: string,
    requestId: string,
    reportedEtaAt: number,
    wallNow: number,
  ): Promise<void> {
    const plan = await this.plans.current(tx);
    await this.upsertRequestState(tx, day.id, requestId, wallNow, {
      reportedEtaAt: null,
      reservedEngineerId: null,
      replanPendingEngineerId: engineerId,
      replanPendingPlanRevision: plan?.revision ?? null,
      replanRequestedAt: BigInt(wallNow),
    });
    const alertId = `live-window-infeasible-${day.id}-${requestId}`;
    await tx.alert.upsert({
      where: { id: alertId },
      update: {
        engineerIds: [engineerId],
        requestIds: [requestId],
        resolvedAt: null,
      },
      create: {
        id: alertId,
        code: 'LIVE_WINDOW_COMPLETION_RISK',
        severity: 'warning',
        engineerIds: [engineerId],
        requestIds: [requestId],
        reasons: [
          {
            code: 'LIVE_WINDOW_COMPLETION_RISK',
            text: 'Прогноз инженера не оставляет времени завершить заявку в допустимом окне.',
            facts: {
              workdayId: day.id,
              requestId,
              reportedEtaAt,
              completionGraceSec: WINDOW_COMPLETION_GRACE_SEC,
            },
          },
        ],
        createdAt: BigInt(wallNow),
      },
    });
  }

  /** A finished or cancelled visit leaves its vertex visible while travel begins. */
  private async departAnchor(
    tx: Tx,
    state: LiveEngineerState,
    requestId: string,
    liveNow: number,
    wallNow: number,
  ): Promise<void> {
    await tx.liveEngineerState.update({
      where: { id: state.id },
      data: {
        routeAnchorRequestId: requestId,
        routeAnchorReachedAt:
          state.routeAnchorRequestId === requestId ? state.routeAnchorReachedAt : BigInt(liveNow),
        routeAnchorDepartedAt: BigInt(liveNow),
        updatedAt: BigInt(wallNow),
        version: { increment: 1 },
      },
    });
  }

  private async problem(
    context: OperationContext,
    day: LiveWorkday,
    state: LiveEngineerState,
    engineerId: string,
    input: Extract<LiveActionDto, { kind: 'problem' }>,
  ) {
    const current = await this.currentFor(context.tx, day, engineerId, context.now);
    this.assertCurrentRequest(current, input.requestId);
    if (input.problemKind === 'delay' && input.additionalDurationSec === undefined) {
      throw new SysError('VALIDATION_FAILED', 'A delay needs an additional duration');
    }
    if (input.problemKind !== 'delay' && input.additionalDurationSec !== undefined) {
      throw new SysError('VALIDATION_FAILED', 'Only a delay may carry an additional duration');
    }
    if (input.problemKind === 'delay' && current.phase !== 'in_progress') {
      throw new SysError(
        'VALIDATION_FAILED',
        'Report additional time only while the visit is in progress',
      );
    }
    if (input.problemKind === 'missing_equipment' && input.missingEquipment === undefined) {
      throw new SysError('VALIDATION_FAILED', 'Choose the missing equipment');
    }
    const note =
      input.problemKind === 'missing_equipment'
        ? `[missing_equipment:${input.missingEquipment}] ${input.note}`
        : input.note;
    await context.tx.requestFact.create({
      data: {
        requestId: input.requestId,
        engineerId,
        kind: 'problem',
        occurredAt: BigInt(context.now),
        recordedAt: BigInt(context.now),
        note,
        operationId: context.operationId,
      },
    });
    await this.upsertRequestState(context.tx, day.id, input.requestId, context.now, {
      reservedEngineerId: engineerId,
      problemKind: input.problemKind,
      problemNote: note,
      additionalDurationSec: input.additionalDurationSec ?? null,
    });
    if (input.problemKind === 'delay') {
      const expected = context.now + (input.additionalDurationSec ?? 0);
      await context.tx.request.update({
        where: { id: input.requestId },
        data: {
          expectedCompletionAt: BigInt(expected),
          continuationAvailableAt: BigInt(expected),
          overrunDetectedAt: null,
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
      await this.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.ENGINEER_FORECAST_CHANGED,
        { businessTime: true },
      );
      return;
    }
    await context.tx.request.update({
      where: { id: input.requestId },
      data: {
        lifecycle: 'cancelled',
        assignmentState: 'unassigned',
        cancelledAt: BigInt(context.now),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    await this.departAnchor(context.tx, state, input.requestId, context.now, context.now);
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.REQUEST_CANCELLED,
      { businessTime: true },
    );
  }

  private async startBreak(
    context: OperationContext,
    state: LiveEngineerState,
    engineerId: string,
  ): Promise<void> {
    const active = await context.tx.request.findFirst({
      where: { lifecycle: 'in_progress', facts: { some: { engineerId, kind: 'started' } } },
      select: { id: true },
    });
    if (active)
      throw new SysError(
        'VALIDATION_FAILED',
        'Finish or report the active visit before a technical break',
      );
    await this.engineers.setAvailability(
      context,
      engineerId,
      'offline',
      context.now + TECHNICAL_BREAK_SEC,
    );
    await context.tx.liveEngineerState.update({
      where: { id: state.id },
      data: {
        lineStatus: 'technical_break',
        technicalBreakStartedAt: BigInt(context.now),
        technicalBreakPlannedEndAt: BigInt(context.now + TECHNICAL_BREAK_SEC),
        technicalBreakOverdueAt: BigInt(context.now + TECHNICAL_BREAK_OVERDUE_SEC),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
  }

  private async finishBreak(
    context: OperationContext,
    state: LiveEngineerState,
    engineerId: string,
  ): Promise<void> {
    if (state.lineStatus !== 'technical_break')
      throw new SysError('VALIDATION_FAILED', 'There is no technical break to finish');
    await this.engineers.setAvailability(context, engineerId, 'online', null);
    await context.tx.liveEngineerState.update({
      where: { id: state.id },
      data: {
        lineStatus: 'online',
        technicalBreakStartedAt: null,
        technicalBreakPlannedEndAt: null,
        technicalBreakOverdueAt: null,
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    await context.tx.alert.updateMany({
      where: {
        id: { startsWith: `live-break-overdue-${state.workdayId}-${engineerId}-` },
        resolvedAt: null,
      },
      data: { resolvedAt: BigInt(context.now) },
    });
  }

  private async advanceIn(
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
    await this.ensureEngineerStates(tx, day.id, wallNow);
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
            noShowAt: BigInt(liveNow),
            updatedAt: BigInt(wallNow),
            version: { increment: 1 },
          },
        });
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
    const plan = await this.plans.current(tx);
    let lunchChanged = false;
    for (const route of plan?.routes ?? []) {
      const lunch = route.stops.find(
        (stop) =>
          stop.kind === 'lunch' && stop.startAt <= BigInt(liveNow) && BigInt(liveNow) < stop.endAt,
      );
      if (!lunch) continue;
      const updated = await tx.engineerDay.updateMany({
        where: {
          engineerId: route.engineerId,
          workDate: day.workDate,
          lunchEnabled: true,
          lunchTaken: false,
        },
        data: {
          lunchTaken: true,
          lunchStartedAt: BigInt(liveNow),
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
            activeLunchStartedAt: BigInt(liveNow),
            updatedAt: BigInt(wallNow),
            version: { increment: 1 },
          },
        });
      }
      lunchChanged ||= updated.count > 0;
    }
    if (lunchChanged)
      await this.publisher.publishIfChanged(
        tx,
        liveNow,
        PUBLICATION_TRIGGERS.ENGINEER_LUNCH_TAKEN,
        { businessTime: true },
      );
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
    let changed = false;
    for (const route of plan?.routes ?? []) {
      const liveState = await tx.liveEngineerState.findUnique({
        where: { workdayId_engineerId: { workdayId: day.id, engineerId: route.engineerId } },
      });
      if (liveState?.lineStatus !== 'online') continue;
      const dayState = await tx.engineerDay.findUnique({
        where: { engineerId_workDate: { engineerId: route.engineerId, workDate: day.workDate } },
        select: { lunchDurationSec: true },
      });
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
      for (const stop of route.stops) {
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
            changed = true;
          }
          continue;
        }
        if (assumedEndAt > liveNow) continue;
        if (!already.has(stop.requestId)) {
          await this.upsertRequestState(tx, day.id, stop.requestId, wallNow, {
            assumedStartedAt: BigInt(assumedStartAt),
            assumedCompletedAt: BigInt(assumedEndAt),
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
          changed = true;
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
        changed = true;
      }
    }
    if (changed)
      await this.publisher.publishIfChanged(
        tx,
        liveNow,
        PUBLICATION_TRIGGERS.LIVE_SILENT_SCHEDULE_PROGRESS,
        { businessTime: true },
      );
    // The legacy coordinator intentionally follows wall time for ordinary API use. LIVE
    // advances a virtual clock, therefore its overrun gate lives here and writes the
    // exact same durable request field/Router trigger.
    const overdue = await tx.request.updateMany({
      where: {
        lifecycle: 'in_progress',
        liveStates: { some: { workdayId: day.id } },
        expectedCompletionAt: { lt: BigInt(liveNow - timing.taskOverrunToleranceSec) },
        overrunDetectedAt: null,
      },
      data: {
        overrunDetectedAt: BigInt(liveNow),
        updatedAt: BigInt(liveNow),
        version: { increment: 1 },
      },
    });
    if (overdue.count > 0) {
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
    const technicalBreak = await tx.liveEngineerState.count({
      where: { workdayId: day.id, lineStatus: 'technical_break' },
    });
    const lunches = await tx.engineerDay.findMany({
      where: { workDate: day.workDate, lunchTaken: true, lunchStartedAt: { not: null } },
      select: { lunchStartedAt: true, lunchDurationSec: true },
    });
    const activeLunch = lunches.some(
      (item) =>
        item.lunchStartedAt !== null &&
        item.lunchDurationSec !== null &&
        Number(item.lunchStartedAt) <= liveNow &&
        liveNow < Number(item.lunchStartedAt) + item.lunchDurationSec,
    );
    const viableDemand = await this.hasViableDemand(tx, day.id, liveNow);
    if (
      unfinished === 0 &&
      technicalBreak === 0 &&
      !activeLunch &&
      (!viableDemand || liveNow >= Number(day.logicalEndAt))
    ) {
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
    }
  }
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

/** Standard product lunch window for the Moscow field-work contour. */
function standardLunchWindow(workDate: string): { startAt: number; endAt: number } {
  return {
    startAt: Math.floor(Date.parse(`${workDate}T11:20:00+03:00`) / 1000),
    endAt: Math.floor(Date.parse(`${workDate}T15:00:00+03:00`) / 1000),
  };
}
