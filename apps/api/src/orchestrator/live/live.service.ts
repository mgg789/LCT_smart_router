import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { LiveActionDto } from '../../api/dto/live.dto';
import type {
  DispatchLiveView,
  EngineerLiveView,
  LiveEngineerStateView,
  LiveWorkdayView,
} from '../../api/live-view.types';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import type { Availability, LiveEngineerState, LiveWorkday } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { APP_STATE_KEYS, PrismaService, type Tx, UnitOfWork } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { AppliedPlanService } from '../../routing/router-gateway';
import { DemoStandService } from '../demo-stand';
import { EngineersService } from '../engineers';
import { assertNoPendingHandoff, confirmHandoff, handoffView } from '../equipment/handoffs';
import { FactsService } from '../facts';
import {
  ExecutionTimingPolicy,
  type ExecutionTimingPolicyValue,
} from '../facts/execution-timing-policy';
import { RewardsService } from '../rewards';
import { type DayWithStates, LiveDayState } from './live-day-state';
import { LiveReadProjection } from './live-read-projection';
import { LiveRouteQuery } from './live-route-query';
import { forfeitsLunchOnLateEntry } from './lunch-forfeit';

import {
  etaNeedsReplan,
  lineStatusAfterDispatcherAvailability,
  MATERIAL_DELAY_SEC,
  NEXT_VISIT_GAP_SEC,
  NO_SHOW_SEC,
} from './replan-policy';

const TECHNICAL_BREAK_SEC = 15 * 60;
const TECHNICAL_BREAK_OVERDUE_SEC = 20 * 60;
const WINDOW_COMPLETION_GRACE_SEC = MATERIAL_DELAY_SEC;
const POST_LUNCH_HANDOFF_GRACE_SEC = 5 * 60;

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
    private readonly rewards: RewardsService,
    private readonly timing: ExecutionTimingPolicy,
    private readonly plans: AppliedPlanService,
    private readonly publisher: SnapshotPublisher,
    private readonly demoStand: DemoStandService,
    private readonly readProjection: LiveReadProjection,
    private readonly dayState: LiveDayState,
    private readonly routeQuery: LiveRouteQuery,
  ) {}

  /**
   * Dispatcher entry.
   *
   * The advance is awaited so a read never observes the day before its automatic
   * transitions (no-show sweep, overrun detection, end-of-shift finish) have applied:
   * a fire-and-forget advance here made the dashboard show a pre-transition status
   * for one poll. The demo reconcile stays fire-and-forget.
   */
  async dispatchView(): Promise<DispatchLiveView> {
    await this.advanceOnce();
    void this.demoStand.reconcile();
    return this.uow.observe(async (tx) => this.dispatchViewIn(tx, this.clock.nowSeconds()));
  }

  /** Starts the pending day exactly once and forces a fresh Router publication at t=0. */
  async start(context: OperationContext): Promise<DispatchLiveView> {
    const pending = await this.dayState.ensureDay(context.tx, context.now);
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
      await this.dayState.ensureEngineerStates(context.tx, day.id, context.now);
      await context.tx.engineerDay.updateMany({
        where: { workDate: day.workDate, lunchEnabled: true, lunchTaken: false },
        data: { lunchRequired: true },
      });
      await this.dayState.captureRouteOrigins(
        context.tx,
        day.id,
        Number(day.logicalStartAt),
        context.now,
      );
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

  /** Engineer entry. A session resolves its own subject in the controller. The advance
   *  is awaited for the same read-your-transitions guarantee as the dispatcher view. */
  async engineerView(engineerId: string): Promise<EngineerLiveView> {
    await this.advanceOnce();
    return this.uow.observe(async (tx) =>
      this.engineerViewIn(tx, engineerId, this.clock.nowSeconds()),
    );
  }

  /** Verifies the current LIVE stop inside the caller's transaction, serialized
   * with engineer actions and automatic day transitions. */
  async assertCurrentRequestIn(
    tx: Tx,
    engineerId: string,
    requestId: string,
    wallNow: number,
  ): Promise<void> {
    const day = await this.dayState.ensureDay(tx, wallNow);
    await tx.$queryRaw`SELECT id FROM live_workdays WHERE id = ${day.id} FOR UPDATE`;
    const full = await this.dayState.dayWithStates(tx, day.id);
    if (full.status !== 'running')
      throw SysError.forbidden('The dispatcher has not started the workday');
    const current = await this.routeQuery.currentFor(
      tx,
      full,
      engineerId,
      this.dayState.liveNow(full, wallNow),
    );
    this.assertCurrentRequest(current, requestId);
    await assertNoPendingHandoff(tx, engineerId, requestId, this.dayState.liveNow(full, wallNow));
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
      const day = await this.dayState.ensureDay(tx, wallNow);
      const lunch = standardLunchWindow(day.workDate);
      const changed = await tx.engineerDay.updateMany({
        where: { workDate: day.workDate, lunchTaken: false },
        data: enabled
          ? {
              lunchEnabled: true,
              lunchRequired: true,
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
          day.status === 'running' ? this.dayState.liveNow(day, wallNow) : wallNow,
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
    const state = await this.dayState.requireEngineerState(
      context.tx,
      day.id,
      engineerId,
      context.now,
    );
    if (state.lineStatus === 'technical_break')
      throw new SysError(
        'VALIDATION_FAILED',
        'The engineer must finish the technical break explicitly',
      );
    const liveNow = this.dayState.liveNow(day, context.now);
    const line = lineStatusAfterDispatcherAvailability(
      availability,
      state.lineStartedAt,
      liveNow,
      Number(day.logicalStartAt),
    );
    await context.tx.liveEngineerState.update({
      where: { id: state.id },
      data: {
        lineStatus: line.lineStatus,
        lineStartedAt: line.lineStartedAt,
        noShowAt: availability === 'online' ? null : state.noShowAt,
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
    const day = await this.dayState.ensureDay(context.tx, context.now);
    if (day.status !== 'running') {
      throw new SysError('VALIDATION_FAILED', 'The dispatcher has not started the workday');
    }
    const liveNow = this.dayState.liveNow(day, context.now);
    await this.advanceIn(context.tx, day, context.now, liveNow);
    const state = await this.dayState.requireEngineerState(
      context.tx,
      day.id,
      engineerId,
      context.now,
    );
    const businessContext: OperationContext = { ...context, now: liveNow, businessTime: true };
    if (input.kind !== 'online' && input.kind !== 'break_finish' && state.lineStatus !== 'online') {
      throw SysError.forbidden('Go online before recording LIVE work actions', {
        lineStatus: state.lineStatus,
      });
    }

    switch (input.kind) {
      case 'handoff_confirm':
        await confirmHandoff(context.tx, input.handoffId, engineerId, day.workDate, liveNow);
        if (
          (await context.tx.equipmentHandoff.findUnique({ where: { id: input.handoffId } }))
            ?.completedAt !== null
        ) {
          await this.publisher.publishIfChanged(
            context.tx,
            liveNow,
            PUBLICATION_TRIGGERS.EQUIPMENT_ISSUED,
            { businessTime: true },
          );
        }
        break;
      case 'online':
        if (state.lineStartedAt !== null) {
          if (state.lineStatus !== 'online')
            throw SysError.forbidden('Only the dispatcher can restore a removed shift');
          break;
        }
        if (state.lineStatus === 'technical_break') {
          throw new SysError(
            'VALIDATION_FAILED',
            'Finish the technical break explicitly before going online',
          );
        }
        await this.engineers.setAvailability(businessContext, engineerId, 'online', null, {
          publish: liveNow >= Number(day.logicalStartAt) + NO_SHOW_SEC,
        });
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
        await context.tx.alert.upsert({
          where: { dedupKey: `notice:line-started:${day.id}:${engineerId}` },
          update: {},
          create: {
            dedupKey: `notice:line-started:${day.id}:${engineerId}`,
            kind: 'notice',
            code: 'engineer_line_started',
            severity: 'info',
            engineerIds: [engineerId],
            requestIds: [],
            workDate: day.workDate,
            reasons: {
              text: `${(await context.tx.engineer.findUniqueOrThrow({ where: { id: engineerId } })).displayName}: выход на линию подтверждён.`,
            },
            isBlocking: false,
            createdAt: BigInt(liveNow),
          },
        });
        await this.forfeitLunchIfLate(context.tx, engineerId, day.workDate, liveNow);
        break;

      case 'eta': {
        const current = await this.routeQuery.currentFor(context.tx, day, engineerId, liveNow);
        this.assertCurrentRequest(current, input.requestId);
        // Once the customer window is open the UI offers an early start *alongside*
        // the ETA controls until the planned service slot begins.
        const forecastOpen =
          current.phase === 'awaiting_window' || current.phase === 'ready_to_start';
        if (!forecastOpen) {
          throw new SysError(
            'VALIDATION_FAILED',
            'Arrival forecast is available only before the visit window',
          );
        }
        const reportedEtaAt = input.etaAt;
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
        const original = await context.tx.appState.upsert({
          where: { key: `live.arrival-baseline.${day.id}.${request.id}` },
          update: {},
          create: {
            key: `live.arrival-baseline.${day.id}.${request.id}`,
            value: { plannedStartAt: current.stop?.startAt ?? liveNow },
            updatedAt: BigInt(liveNow),
          },
        });
        const plannedStartAt = z
          .object({ plannedStartAt: z.number() })
          .parse(original.value).plannedStartAt;
        const originalArrivalDeadline = plannedStartAt;
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
        const priorEta = await context.tx.liveRequestState.findUnique({
          where: { workdayId_requestId: { workdayId: day.id, requestId: input.requestId } },
          select: { reportedEtaBaselineAt: true },
        });
        await this.upsertRequestState(context.tx, day.id, input.requestId, context.now, {
          reportedEtaAt: BigInt(reportedEtaAt),
          // Promise ordering is evaluated on the accelerated LIVE clock. The ledger
          // still uses context.now as its wall-time month bucket.
          reportedEtaRecordedAt: BigInt(liveNow),
          ...(priorEta?.reportedEtaBaselineAt === null || priorEta === null
            ? { reportedEtaBaselineAt: BigInt(originalArrivalDeadline) }
            : {}),
          reservedEngineerId: engineerId,
        });
        if (
          etaNeedsReplan(
            reportedEtaAt,
            plannedStartAt,
            request.serviceDurationSec,
            request.windowEndAt,
          )
        ) {
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
        await assertNoPendingHandoff(context.tx, engineerId, input.requestId, liveNow);
        const current = await this.routeQuery.currentFor(context.tx, day, engineerId, liveNow);
        this.assertCurrentRequest(current, input.requestId);
        if (current.phase !== 'ready_to_start') {
          throw new SysError('VALIDATION_FAILED', 'This visit is not ready to start yet');
        }
        const acceptedPromise = await context.tx.liveRequestState.findUnique({
          where: { workdayId_requestId: { workdayId: day.id, requestId: input.requestId } },
          select: {
            reportedEtaAt: true,
            reportedEtaRecordedAt: true,
            reportedEtaBaselineAt: true,
            reservedEngineerId: true,
          },
        });
        await this.facts.record(
          businessContext,
          engineerId,
          input.requestId,
          'started',
          liveNow,
          null,
          this.timing.current(),
        );
        await this.rewards.evaluateArrival(context, {
          engineerId,
          requestId: input.requestId,
          workdayId: day.id,
          actualAt: liveNow,
          // Once an ETA reservation overlays the route, current.stop.startAt is the
          // promise itself. Preserve the first plan baseline for the ordinary 40-point
          // branch; otherwise a revised promise would be misclassified as ordinary.
          plannedAt:
            acceptedPromise?.reportedEtaBaselineAt === null || acceptedPromise === null
              ? (current.stop?.startAt ?? liveNow)
              : Number(acceptedPromise.reportedEtaBaselineAt),
          windowStartAt: current.current?.request.windowStartAt ?? liveNow,
          promiseAt:
            acceptedPromise?.reportedEtaAt === null || acceptedPromise === null
              ? null
              : Number(acceptedPromise.reportedEtaAt),
          promiseRecordedAt:
            acceptedPromise?.reportedEtaRecordedAt === null || acceptedPromise === null
              ? null
              : Number(acceptedPromise.reportedEtaRecordedAt),
          baselineAt:
            acceptedPromise?.reportedEtaBaselineAt === null || acceptedPromise === null
              ? null
              : Number(acceptedPromise.reportedEtaBaselineAt),
          ownerMatches:
            acceptedPromise?.reservedEngineerId === undefined
              ? true
              : acceptedPromise.reservedEngineerId === null ||
                acceptedPromise.reservedEngineerId === engineerId,
          logicalActionAt: liveNow,
        });
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
        const activeRequest = await context.tx.request.findUniqueOrThrow({
          where: { id: input.requestId },
          select: { serviceDurationSec: true, startedAt: true },
        });
        const acceptedPromise = await context.tx.liveRequestState.findFirst({
          where: { workdayId: day.id, requestId: input.requestId },
          select: {
            promisedFinishAt: true,
            promisedFinishRecordedAt: true,
            promisedFinishBaselineAt: true,
            reservedEngineerId: true,
          },
        });
        await this.facts.record(
          businessContext,
          engineerId,
          input.requestId,
          'finished',
          liveNow,
          null,
          this.timing.current(),
        );
        if (activeRequest.startedAt !== null) {
          // A delay mutates the request's current duration for routing. The first
          // accepted promise keeps the original norm frozen for the 40-vs-30 decision.
          const originalFinishAt =
            acceptedPromise?.promisedFinishBaselineAt === null || acceptedPromise === null
              ? Number(activeRequest.startedAt) + activeRequest.serviceDurationSec
              : Number(acceptedPromise.promisedFinishBaselineAt);
          const promisedFinishAt =
            acceptedPromise?.promisedFinishAt === null || acceptedPromise === null
              ? null
              : Number(acceptedPromise.promisedFinishAt);
          await this.rewards.evaluateCompletion(context, {
            engineerId,
            requestId: input.requestId,
            workdayId: day.id,
            actualAt: liveNow,
            originalFinishAt,
            promiseAt: promisedFinishAt,
            promiseRecordedAt:
              acceptedPromise?.promisedFinishRecordedAt === null || acceptedPromise === null
                ? null
                : Number(acceptedPromise.promisedFinishRecordedAt),
            baselineAt:
              acceptedPromise?.promisedFinishBaselineAt === null || acceptedPromise === null
                ? originalFinishAt
                : Number(acceptedPromise.promisedFinishBaselineAt),
            allowAfterBaseline:
              acceptedPromise?.promisedFinishAt !== null &&
              acceptedPromise?.promisedFinishBaselineAt !== null &&
              acceptedPromise !== null &&
              Number(acceptedPromise.promisedFinishAt) >
                Number(acceptedPromise.promisedFinishBaselineAt),
            ownerMatches:
              acceptedPromise?.reservedEngineerId === null ||
              acceptedPromise?.reservedEngineerId === engineerId,
            logicalActionAt: liveNow,
          });
        }
        await this.departAnchor(context.tx, state, input.requestId, liveNow, context.now);
        break;
      }

      case 'problem':
        await this.problem(businessContext, day, state, engineerId, input, liveNow);
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
        await this.advanceIn(tx, day, wallNow, this.dayState.liveNow(day, wallNow), timing);
      }
    });
  }

  private async dispatchViewIn(tx: Tx, wallNow: number): Promise<DispatchLiveView> {
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
    };
  }

  private async breakHistory(tx: Tx, day: LiveWorkday): Promise<DispatchLiveView['breaks']> {
    return this.readProjection.breakHistory(tx, day);
  }

  private async engineerViewIn(
    tx: Tx,
    engineerId: string,
    wallNow: number,
  ): Promise<EngineerLiveView> {
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
      current: current.current,
      lunch,
    };
  }

  /** Archived and synthetic leftovers are not a roster the coordinator can mutate. */
  private async activeRosterEngineer(tx: Tx, engineerId: string): Promise<boolean> {
    const engineer = await tx.engineer.findFirst({
      where: { id: engineerId, archivedAt: null },
      select: { id: true },
    });
    return engineer !== null;
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
  private async canEngineerFinishDay(
    tx: Tx,
    day: LiveWorkday,
    state: LiveEngineerState,
    liveNow: number,
  ): Promise<boolean> {
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

  private assertCurrentRequest(
    current: Awaited<ReturnType<LiveRouteQuery['currentFor']>>,
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
        createdAt: BigInt(this.dayState.liveNow(day, wallNow)),
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
    logicalNow: number,
  ) {
    const current = await this.routeQuery.currentFor(context.tx, day, engineerId, context.now);
    this.assertCurrentRequest(current, input.requestId);
    if (input.problemKind === 'delay' && input.additionalDurationSec === undefined) {
      throw new SysError('VALIDATION_FAILED', 'A delay needs an additional duration');
    }
    if (input.problemKind !== 'delay' && input.additionalDurationSec !== undefined) {
      throw new SysError('VALIDATION_FAILED', 'Only a delay may carry an additional duration');
    }
    if (input.problemKind === 'delay' && current.phase !== 'in_progress') {
      const extra = input.additionalDurationSec ?? 0;
      const stored = await context.tx.request.findUniqueOrThrow({
        where: { id: input.requestId },
        select: {
          serviceDurationSec: true,
          documentationDurationSec: true,
          windowStartAt: true,
          windowEndAt: true,
        },
      });
      const nextDuration = stored.serviceDurationSec + extra;
      const windowEndAt = Math.max(
        Number(stored.windowEndAt),
        Number(stored.windowStartAt) + nextDuration,
      );
      await context.tx.request.update({
        where: { id: input.requestId },
        data: {
          // Keep the workbook identity: service_duration_sec = technical + documentation.
          serviceDurationSec: nextDuration,
          technicalDurationSec: nextDuration - stored.documentationDurationSec,
          windowEndAt: BigInt(windowEndAt),
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
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
    const priorPromise = await context.tx.liveRequestState.findUnique({
      where: { workdayId_requestId: { workdayId: day.id, requestId: input.requestId } },
      select: { promisedFinishRecordedAt: true },
    });
    await this.upsertRequestState(context.tx, day.id, input.requestId, context.now, {
      reservedEngineerId: engineerId,
      problemKind: input.problemKind,
      problemNote: note,
      additionalDurationSec: input.additionalDurationSec ?? null,
    });
    if (input.problemKind === 'delay') {
      if (current.phase === 'in_progress') {
        const actualStart = current.current?.request.startedAt;
        const norm = current.current?.request.serviceDurationSec;
        const stored = await context.tx.request.findUniqueOrThrow({
          where: { id: input.requestId },
          select: {
            expectedCompletionAt: true,
            startedAt: true,
            serviceDurationSec: true,
            documentationDurationSec: true,
          },
        });
        const originalFinish =
          stored.expectedCompletionAt ??
          (stored.startedAt === null
            ? BigInt(logicalNow)
            : BigInt(Number(stored.startedAt) + stored.serviceDurationSec));
        // Before the deadline this extends the remaining norm; once overdue it
        // extends from now. An early report must never shorten the original task.
        // Both duration columns move together so the workbook identity holds.
        const expected =
          Math.max(logicalNow, Number(originalFinish)) + (input.additionalDurationSec ?? 0);
        if (priorPromise?.promisedFinishRecordedAt === null || priorPromise === null) {
          await this.upsertRequestState(context.tx, day.id, input.requestId, context.now, {
            promisedFinishAt: BigInt(expected),
            // Promise ordering is evaluated on the accelerated LIVE clock; the
            // reward row itself retains the wall timestamp for month accounting.
            promisedFinishRecordedAt: BigInt(logicalNow),
            promisedFinishBaselineAt: originalFinish,
          });
        }
        await context.tx.request.update({
          where: { id: input.requestId },
          data: {
            ...(actualStart !== null && actualStart !== undefined
              ? {
                  serviceDurationSec: expected - actualStart,
                  technicalDurationSec: expected - actualStart - stored.documentationDurationSec,
                }
              : {}),
            expectedCompletionAt: BigInt(expected),
            continuationAvailableAt: BigInt(expected),
            overrunDetectedAt: null,
            updatedAt: BigInt(context.now),
            version: { increment: 1 },
          },
        });
        if (
          actualStart !== null &&
          actualStart !== undefined &&
          norm !== undefined &&
          expected > actualStart + norm + MATERIAL_DELAY_SEC
        ) {
          await this.publisher.publishIfChanged(
            context.tx,
            context.now,
            PUBLICATION_TRIGGERS.ENGINEER_FORECAST_CHANGED,
            { businessTime: true },
          );
        }
      } else {
        await this.publisher.publishIfChanged(
          context.tx,
          context.now,
          PUBLICATION_TRIGGERS.REQUEST_CONDITIONS_CHANGED,
        );
      }
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
    const sequence = current.stop?.sequence;
    const next =
      sequence === undefined
        ? null
        : current.route?.stops
            .filter((stop) => stop.kind === 'job' && stop.sequence > sequence)
            .sort((a, b) => a.sequence - b.sequence)[0];
    if (next && next.startAt - context.now > NEXT_VISIT_GAP_SEC)
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
      if (appActiveEngineers.has(route.engineerId)) continue;
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
    const dayStart = Date.parse(`${day.workDate}T00:00:00+03:00`) / 1000;
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

  /** Entering the line during the lunch window spends that day's lunch. */
  private async forfeitLunchIfLate(
    tx: Tx,
    engineerId: string,
    workDate: string,
    liveNow: number,
  ): Promise<void> {
    const engineerDay = await tx.engineerDay.findUnique({
      where: { engineerId_workDate: { engineerId, workDate } },
    });
    if (
      !engineerDay ||
      !forfeitsLunchOnLateEntry({
        liveNow,
        enabled: engineerDay.lunchEnabled,
        taken: engineerDay.lunchTaken,
        windowStartAt: engineerDay.lunchWindowStartAt,
        windowEndAt: engineerDay.lunchWindowEndAt,
      })
    ) {
      return;
    }
    await tx.engineerDay.update({
      where: { id: engineerDay.id },
      data: { lunchTaken: true, updatedAt: BigInt(liveNow), version: { increment: 1 } },
    });
    await this.publisher.publishIfChanged(tx, liveNow, PUBLICATION_TRIGGERS.ENGINEER_LUNCH_TAKEN, {
      businessTime: true,
    });
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
