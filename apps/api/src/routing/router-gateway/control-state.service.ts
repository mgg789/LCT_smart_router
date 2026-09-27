import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { ControlMode } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { workDateOf } from '../../orchestrator/engineers/workday';
import { businessNow } from '../../orchestrator/live/business-clock';
import type { Tx } from '../../persistence';
import { lockControlState } from '../../persistence';
import { SnapshotPublisher } from '../mount-data-eng/snapshot.publisher';
import { readManualState, writeManualState } from './manual-state';

export interface ControlStateView {
  readonly mode: ControlMode;
  readonly modeVersion: number;
  readonly changedAt: number;
  readonly frozenPlanId: string | null;
}

/** Manual intents constrain continuous LIVE routing without rewriting execution facts. */
@Injectable()
export class ControlStateService {
  private readonly logger = new Logger(ControlStateService.name);

  constructor(private readonly publisher: SnapshotPublisher) {}

  async current(tx: Tx): Promise<ControlStateView> {
    const state = await tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    return {
      mode: state.mode,
      modeVersion: state.modeVersion,
      changedAt: Number(state.changedAt),
      frozenPlanId: state.frozenPlanId,
    };
  }

  /** Starts an empty, reasoned session; current and future Router results keep applying. */
  async enterManual(context: OperationContext, reason?: string): Promise<ControlStateView> {
    await lockControlState(context.tx);
    const state = await context.tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    if (state.mode === 'manual') {
      return this.current(context.tx);
    }

    if (!reason?.trim()) throw SysError.validationFailed('Укажите причину перехода в ручной режим');
    const previous = await readManualState(context.tx);
    await writeManualState(
      context.tx,
      {
        version: previous.version + 1,
        reason: reason.trim(),
        workDate: workDateOf(await businessNow(context.tx, context.now), 'Europe/Moscow'),
        decisions: [],
        acknowledgedConflicts: [],
        resolution: null,
      },
      context.now,
    );
    const frozen =
      (await context.tx.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } }))?.planId ??
      null;
    await context.tx.controlState.update({
      where: { id: 'singleton' },
      data: {
        mode: 'manual',
        modeVersion: { increment: 1 },
        changedAt: BigInt(context.now),
        changedBy: context.actor.id,
        frozenPlanId: frozen,
      },
    });
    this.logger.log(`Manual preferences enabled; live routing continues`);
    return this.current(context.tx);
  }

  /** Clears all intents and publishes original conditions with current execution facts. */
  async returnToAuto(context: OperationContext): Promise<ControlStateView> {
    await lockControlState(context.tx);
    const state = await context.tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    if (state.mode === 'auto') {
      return this.current(context.tx);
    }
    await context.tx.controlState.update({
      where: { id: 'singleton' },
      data: {
        mode: 'auto',
        modeVersion: { increment: 1 },
        changedAt: BigInt(context.now),
        changedBy: context.actor.id,
        frozenPlanId: null,
      },
    });
    const manual = await readManualState(context.tx);
    await writeManualState(
      context.tx,
      {
        ...manual,
        version: manual.version + 1,
        reason: null,
        decisions: [],
        acknowledgedConflicts: [],
        resolution: null,
      },
      context.now,
    );
    await this.publisher.publishIfChanged(context.tx, context.now, 'manual.decisions_changed', {
      force: true,
    });
    this.logger.log('Automatic mode restored; manual preferences cleared');
    return this.current(context.tx);
  }

  /** Guards the manual-only editing operations. */
  async assertManual(tx: Tx): Promise<void> {
    const state = await this.current(tx);
    if (state.mode !== 'manual') {
      throw new SysError(
        'MODE_AUTO',
        'The working plan is owned by the accepted result while automatic mode is on',
        { details: { mode: state.mode } },
      );
    }
  }
}
