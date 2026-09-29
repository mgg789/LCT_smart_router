import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { configuredTimeZone } from '../../common/time/zone';
import type { Engineer, Request } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { workDateOf } from '../../orchestrator/engineers/workday';
import { businessNow } from '../../orchestrator/live/business-clock';
import { requireWindowConfirmation } from '../../orchestrator/requests/window-confirmation';
import { lockControlState } from '../../persistence';
import { SnapshotPublisher } from '../mount-data-eng/snapshot.publisher';
import {
  type ManualDecision,
  type ManualState,
  manualStateView,
  readManualState,
  writeManualState,
} from './manual-state';

/** Saves versioned dispatcher preferences and publishes them for live routing. */
@Injectable()
export class ManualDecisionsService {
  constructor(private readonly publisher: SnapshotPublisher) {}

  private async editable(context: OperationContext, version: number): Promise<ManualState> {
    await lockControlState(context.tx);
    const control = await context.tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    if (control.mode !== 'manual') throw new SysError('MODE_AUTO', 'Включите ручной режим');
    const state = await readManualState(context.tx);
    if (state.version !== version)
      throw new SysError('VERSION_CONFLICT', 'Ручные решения изменились. Обновите панель.');
    const date = workDateOf(await businessNow(context.tx, context.now), configuredTimeZone());
    if (state.workDate !== date)
      throw SysError.validationFailed(
        'Ручная сессия относится к другому дню. Вернитесь в Авто и включите Manual заново.',
      );
    return state;
  }

  /** Changes only an intent; execution facts and canonical customer windows are retained. */
  async put(
    context: OperationContext,
    version: number,
    input: Omit<ManualDecision, 'id' | 'priority'>,
  ) {
    const state = await this.editable(context, version);
    const now = await businessNow(context.tx, context.now);
    const workDate = state.workDate;
    if (!workDate) throw SysError.validationFailed('Нет даты ручной сессии');
    const { startAt, endAt } = input;
    if (
      input.kind !== 'assignment' &&
      (input.startAt === undefined || input.endAt === undefined || input.endAt <= input.startAt)
    )
      throw SysError.validationFailed('Укажите начало и конец временного интервала');
    if (input.kind === 'assignment' || input.kind === 'window') {
      const request = await context.tx.request.findUniqueOrThrow({ where: { id: input.targetId } });
      if (request.lat === null || request.lon === null)
        throw SysError.validationFailed('Сначала укажите координаты заявки');
      const live = await context.tx.liveRequestState.findFirst({
        where: { requestId: request.id, workday: { status: 'running' } },
      });
      if (
        request.lifecycle !== 'submitted' ||
        live?.assumedStartedAt != null ||
        live?.assumedCompletedAt != null
      )
        throw SysError.validationFailed('Нельзя менять уже начатую или завершённую заявку');
      if (input.kind === 'window') {
        if (startAt === undefined || endAt === undefined)
          throw SysError.validationFailed('Укажите окно');
        if (request.workCategory === 'emergency')
          throw SysError.validationFailed(
            'Авария выполняется сразу после освобождения бригады, окно не задаётся',
          );
        const previous = state.decisions.find(
          (item) => item.kind === 'window' && item.targetId === request.id,
        );
        requireWindowConfirmation(context.actor, {
          requestId: request.id,
          version: state.version,
          previousStartAt: previous?.startAt ?? Number(request.windowStartAt),
          previousEndAt: previous?.endAt ?? Number(request.windowEndAt),
          windowStartAt: startAt,
          windowEndAt: endAt,
        });
      } else if (input.engineerId) {
        const day = await context.tx.engineerDay.findUnique({
          where: {
            engineerId_workDate: { engineerId: input.engineerId, workDate: workDate },
          },
          include: { engineer: true },
        });
        if (day?.availability !== 'online' || day.engineer.archivedAt !== null)
          throw SysError.validationFailed('Выберите инженера на линии');
        assertManualAssignmentEligibility(request, day.engineer);
      } else if (input.engineerId !== null)
        throw SysError.validationFailed('Выберите инженера или «Никто»');
      if (
        (await context.tx.equipmentLogistics.count({
          where: { requestId: request.id, status: 'assigned' },
        })) ||
        (await context.tx.equipmentHandoff.count({
          where: { requestId: request.id, completedAt: null },
        }))
      )
        throw SysError.validationFailed(
          'Сначала завершите принятую передачу оборудования этой заявки',
        );
    } else {
      const day = await context.tx.engineerDay.findUnique({
        where: { engineerId_workDate: { engineerId: input.targetId, workDate: workDate } },
      });
      if (!day) throw SysError.validationFailed('У инженера нет смены в этом дне');
      if (input.kind === 'lunch' && (day.lunchTaken || day.lunchStartedAt !== null))
        throw SysError.validationFailed('Обед уже начат или завершён');
      if (endAt === undefined || endAt <= now)
        throw SysError.validationFailed('Интервал уже закончился');
    }
    const previous = state.decisions.find(
      (item) => item.kind === input.kind && item.targetId === input.targetId,
    );
    const decision: ManualDecision = {
      ...input,
      id: previous?.id ?? randomUUID(),
      priority: Math.min(0, ...state.decisions.map((item) => item.priority)),
    };
    const next = {
      ...state,
      version: state.version + 1,
      decisions: [...state.decisions.filter((item) => item.id !== decision.id), decision],
      acknowledgedConflicts: [],
      resolution: null,
    };
    if (next.decisions.length > 100)
      throw SysError.validationFailed('Слишком много ручных решений для одного дня');
    return this.save(context, next);
  }

  /** Applies an exact permutation, preserving every decision and acknowledging current conflicts. */
  async reorder(context: OperationContext, version: number, ids: string[]) {
    const state = await this.editable(context, version);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== state.decisions.length ||
      ids.some((id) => !state.decisions.some((item) => item.id === id))
    )
      throw SysError.validationFailed('Список должен содержать каждое решение ровно один раз');
    const next = {
      ...state,
      version: state.version + 1,
      decisions: ids.map((id, priority) => ({
        ...requiredDecision(state, id),
        priority,
      })),
      acknowledgedConflicts: state.resolution?.conflictIds ?? [],
      resolution: null,
    };
    return this.save(context, next);
  }

  /** Removes an intent without changing the original conditions. */
  async remove(context: OperationContext, version: number, id: string) {
    const state = await this.editable(context, version);
    return this.save(context, {
      ...state,
      version: state.version + 1,
      decisions: state.decisions.filter((item) => item.id !== id),
      acknowledgedConflicts: [],
      resolution: null,
    });
  }

  private async save(context: OperationContext, state: ManualState) {
    await writeManualState(context.tx, state, context.now);
    await this.publisher.publishIfChanged(context.tx, context.now, 'manual.decisions_changed');
    return manualStateView(state);
  }
}

/** Exact-permutation validation guarantees every requested decision exists. */
function requiredDecision(state: ManualState, id: string): ManualDecision {
  const decision = state.decisions.find((item) => item.id === id);
  if (!decision) throw SysError.validationFailed('Неизвестное ручное решение');
  return decision;
}

/** Reject only immutable hard eligibility mismatches; equipment may still be supplied en route. */
export function assertManualAssignmentEligibility(
  request: Pick<Request, 'id' | 'requiredSkill' | 'requiredTransport'>,
  engineer: Pick<Engineer, 'id' | 'skills' | 'transportType'>,
): void {
  const reason = !engineer.skills.includes(request.requiredSkill)
    ? 'skill'
    : request.requiredTransport !== null && engineer.transportType !== request.requiredTransport
      ? 'transport'
      : null;
  if (reason)
    throw new SysError(
      'VALIDATION_FAILED',
      reason === 'skill'
        ? 'У выбранного инженера нет навыка, необходимого для этой заявки.'
        : 'Транспорт выбранного инженера не подходит для этой заявки.',
      {
        details: {
          kind: 'manual_assignment_ineligible',
          reason,
          requestId: request.id,
          engineerId: engineer.id,
          requiredSkill: request.requiredSkill,
          requiredTransport: request.requiredTransport,
        },
      },
    );
}
