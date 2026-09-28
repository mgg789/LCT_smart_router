import type { LiveActionDto } from '../../api/dto/live.dto';
import { SysError } from '../../common/errors';
import type { LiveEngineerState, LiveWorkday } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { EngineersService } from '../engineers';
import { LiveRouteQuery } from './live-route-query';
import { MATERIAL_DELAY_SEC, NEXT_VISIT_GAP_SEC } from './replan-policy';

const TECHNICAL_BREAK_SEC = 15 * 60;
const TECHNICAL_BREAK_OVERDUE_SEC = 20 * 60;

/** Handles engineer problem reports and technical breaks within the caller transaction. */
export class LiveActionHandler {
  constructor(
    private readonly routeQuery: LiveRouteQuery,
    private readonly engineers: EngineersService,
    private readonly publisher: SnapshotPublisher,
    private readonly assertCurrentRequest: (
      current: Awaited<ReturnType<LiveRouteQuery['currentFor']>>,
      requestId: string,
    ) => void,
    private readonly departAnchor: (
      tx: Tx,
      state: LiveEngineerState,
      requestId: string,
      liveNow: number,
      wallNow: number,
    ) => Promise<void>,
    private readonly upsertRequestState: (
      tx: Tx,
      workdayId: string,
      requestId: string,
      wallNow: number,
      data: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}

  async problem(
    context: OperationContext,
    day: LiveWorkday,
    state: LiveEngineerState,
    engineerId: string,
    input: Extract<LiveActionDto, { kind: 'problem' }>,
    logicalNow: number,
    equipmentTransfersEnabled = false,
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
    if (
      input.problemKind === 'missing_equipment' &&
      input.missingEquipment !== undefined &&
      equipmentTransfersEnabled &&
      current.phase === 'in_progress'
    ) {
      const request = await context.tx.request.findUniqueOrThrow({
        where: { id: input.requestId },
      });
      if (request.lat === null || request.lon === null)
        throw new SysError('VALIDATION_FAILED', 'The delivery address needs coordinates');
      const existing = await context.tx.equipmentLogistics.findUnique({
        where: { workDate_requestId: { workDate: day.workDate, requestId: input.requestId } },
      });
      if (existing) {
        if (existing.equipmentType !== input.missingEquipment)
          throw new SysError(
            'VALIDATION_FAILED',
            'Another equipment search already exists for this visit',
          );
        return;
      }
      await context.tx.equipmentLogistics.create({
        data: {
          id: context.operationId,
          workDate: day.workDate,
          kind: 'donor_delivery',
          status: 'searching',
          requestId: input.requestId,
          receiverEngineerId: engineerId,
          equipmentType: input.missingEquipment,
          lat: request.lat,
          lon: request.lon,
          waitStartedAt: BigInt(logicalNow),
          baselineCompletionAt:
            request.expectedCompletionAt ??
            BigInt(Number(request.startedAt) + request.serviceDurationSec),
          createdAt: BigInt(context.now),
          updatedAt: BigInt(context.now),
        },
      });
      await context.tx.requestFact.create({
        data: {
          requestId: input.requestId,
          engineerId,
          kind: 'problem',
          occurredAt: BigInt(logicalNow),
          recordedAt: BigInt(context.now),
          operationId: context.operationId,
          note: `[missing_equipment:${input.missingEquipment}] ${input.note}`,
        },
      });
      await this.upsertRequestState(context.tx, day.id, input.requestId, context.now, {
        reservedEngineerId: engineerId,
        problemKind: 'missing_equipment',
        problemNote: input.note,
      });
      return;
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

  async startBreak(
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

  async finishBreak(
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
}
