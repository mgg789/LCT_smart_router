import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { LiveActionDto } from '../../api/dto/live.dto';
import type { DispatchLiveView, EngineerLiveView } from '../../api/live-view.types';
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
import { assertNoPendingHandoff, confirmHandoff } from '../equipment/handoffs';
import { confirmLogistics } from '../equipment/logistics';
import { EquipmentLogisticsService } from '../equipment/logistics.service';
import { FactsService } from '../facts';
import { ExecutionTimingPolicy } from '../facts/execution-timing-policy';
import { RewardsService } from '../rewards';
import { LiveActionHandler } from './live-action-handler';
import { LiveAdvancer } from './live-advancer';
import { LiveDayState } from './live-day-state';
import { LiveReadProjection } from './live-read-projection';
import { LiveRouteQuery } from './live-route-query';
import { LiveViews } from './live-views';
import { forfeitsLunchOnLateEntry } from './lunch-forfeit';

import {
  etaNeedsReplan,
  lineStatusAfterDispatcherAvailability,
  MATERIAL_DELAY_SEC,
  NO_SHOW_SEC,
} from './replan-policy';

const WINDOW_COMPLETION_GRACE_SEC = MATERIAL_DELAY_SEC;

/**
 * Persistent LIVE business flow. It maps wall-clock time onto the imported logical
 * timeline without changing auth/session time or the Router contracts. Every automatic
 * transition is a durable state change, so restart and a second API instance resume the
 * same day instead of keeping a process-local stopwatch.
 */
@Injectable()
export class LiveService {
  private advanceInFlight: Promise<void> | null = null;
  private readonly views: LiveViews;
  private readonly advancer: LiveAdvancer;
  private readonly actionHandler: LiveActionHandler;

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
    readProjection: LiveReadProjection,
    private readonly dayState: LiveDayState,
    private readonly routeQuery: LiveRouteQuery,
    private readonly logistics: EquipmentLogisticsService,
  ) {
    this.views = new LiveViews(dayState, readProjection, routeQuery, plans, demoStand);
    this.advancer = new LiveAdvancer(
      dayState,
      engineers,
      plans,
      publisher,
      timing,
      (tx, day, state, liveNow) => this.views.canEngineerFinishDay(tx, day, state, liveNow),
      (tx, workdayId, requestId, wallNow, data) =>
        this.upsertRequestState(tx, workdayId, requestId, wallNow, data),
    );
    this.actionHandler = new LiveActionHandler(
      routeQuery,
      engineers,
      publisher,
      (current, requestId) => this.assertCurrentRequest(current, requestId),
      (tx, state, requestId, liveNow, wallNow) =>
        this.departAnchor(tx, state, requestId, liveNow, wallNow),
      (tx, workdayId, requestId, wallNow, data) =>
        this.upsertRequestState(tx, workdayId, requestId, wallNow, data),
    );
  }

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
    return this.uow.observe(async (tx) => this.views.dispatchViewIn(tx, this.clock.nowSeconds()));
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
    return this.views.dispatchViewIn(context.tx, context.now);
  }

  /** Engineer entry. A session resolves its own subject in the controller. The advance
   *  is awaited for the same read-your-transitions guarantee as the dispatcher view. */
  async engineerView(engineerId: string): Promise<EngineerLiveView> {
    await this.advanceOnce();
    return this.uow.observe(async (tx) =>
      this.views.engineerViewIn(tx, engineerId, this.clock.nowSeconds()),
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
    equipmentTransfersEnabled = false,
  ): Promise<EngineerLiveView> {
    const day = await this.dayState.ensureDay(context.tx, context.now);
    if (day.status !== 'running') {
      throw new SysError('VALIDATION_FAILED', 'The dispatcher has not started the workday');
    }
    const liveNow = this.dayState.liveNow(day, context.now);
    await this.advancer.advanceIn(context.tx, day, context.now, liveNow);
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
      case 'equipment_delivery_confirm':
      case 'office_pickup_confirm':
        await confirmLogistics(
          context.tx,
          input.logisticsId,
          engineerId,
          day.workDate,
          liveNow,
          input.kind === 'equipment_delivery_confirm' ? 'donor_delivery' : 'office_pickup',
        );
        await this.publisher.publishIfChanged(
          context.tx,
          liveNow,
          PUBLICATION_TRIGGERS.EQUIPMENT_ISSUED,
          { businessTime: true },
        );
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
          return this.views.engineerViewIn(context.tx, engineerId, context.now);
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
        const pendingPickup = await context.tx.equipmentLogistics.findFirst({
          where: {
            requestId: input.requestId,
            workDate: day.workDate,
            status: 'assigned',
            kind: 'office_pickup',
          },
        });
        if (pendingPickup)
          throw new SysError(
            'VALIDATION_FAILED',
            'Confirm equipment collection at the office first',
          );
        await assertNoPendingHandoff(context.tx, engineerId, input.requestId, liveNow);
        const current = await this.routeQuery.currentFor(context.tx, day, engineerId, liveNow);
        this.assertCurrentRequest(current, input.requestId);
        if (current.phase !== 'ready_to_start') {
          throw new SysError('VALIDATION_FAILED', 'This visit is not ready to start yet');
        }
        const priorDelivery = await context.tx.equipmentLogistics.findFirst({
          where: {
            workDate: day.workDate,
            status: 'assigned',
            donorEngineerId: engineerId,
            expectedAt: {
              lt: BigInt(
                Math.max(
                  Number(current.stop?.startAt ?? liveNow),
                  liveNow + (current.current?.request.serviceDurationSec ?? 0),
                ),
              ),
            },
          },
        });
        if (priorDelivery)
          throw new SysError(
            'VALIDATION_FAILED',
            'Complete the scheduled equipment delivery before this visit',
          );
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
        const waiting = await context.tx.equipmentLogistics.findFirst({
          where: {
            requestId: input.requestId,
            workDate: day.workDate,
            status: { in: ['searching', 'assigned', 'error'] },
          },
        });
        if (waiting)
          throw new SysError(
            'VALIDATION_FAILED',
            'Equipment logistics must be resolved before finishing this visit',
          );
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
        await this.actionHandler.problem(
          businessContext,
          day,
          state,
          engineerId,
          input,
          liveNow,
          equipmentTransfersEnabled,
        );
        break;

      case 'break_start':
        await this.actionHandler.startBreak(businessContext, state, engineerId);
        break;

      case 'break_finish':
        await this.actionHandler.finishBreak(businessContext, state, engineerId);
        break;
    }
    return this.views.engineerViewIn(context.tx, engineerId, context.now);
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
    await this.logistics.runOnce();
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
        await this.advancer.advanceIn(
          tx,
          day,
          wallNow,
          this.dayState.liveNow(day, wallNow),
          timing,
        );
      }
    });
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

/** Standard product lunch window for the Moscow field-work contour. */
function standardLunchWindow(workDate: string): { startAt: number; endAt: number } {
  return {
    startAt: Math.floor(Date.parse(`${workDate}T11:20:00+03:00`) / 1000),
    endAt: Math.floor(Date.parse(`${workDate}T15:00:00+03:00`) / 1000),
  };
}
