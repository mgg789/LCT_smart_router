import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { ControlMode } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { lockControlState } from '../../persistence';
import { AppliedPlanService } from './applied-plan.service';

export interface ControlStateView {
  readonly mode: ControlMode;
  readonly modeVersion: number;
  readonly changedAt: number;
  readonly frozenPlanId: string | null;
}

/**
 * AUTO and MANUAL.
 *
 * Emergency manual control disconnects exactly one thing: the delivery of Router's result
 * into sys. It does not stop Router, the reading of the sector, the intake of requests,
 * GPS, sign-in or actual events. Router keeps computing; its answers simply stay inside
 * Router (context/32 section 7.1).
 *
 * Returning to AUTO is an explicit transition, not an ordinary re-read. The current
 * result replaces the *future* manual distribution; it does not merge with it and does not
 * undo anything that already happened (context/32 section 7.3).
 */
@Injectable()
export class ControlStateService {
  private readonly logger = new Logger(ControlStateService.name);

  constructor(private readonly plans: AppliedPlanService) {}

  async current(tx: Tx): Promise<ControlStateView> {
    const state = await tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    return {
      mode: state.mode,
      modeVersion: state.modeVersion,
      changedAt: Number(state.changedAt),
      frozenPlanId: state.frozenPlanId,
    };
  }

  /**
   * Switches to manual control.
   *
   * The plan in force is frozen as the starting point, and from then on the dispatcher is
   * its author. The lock matters: a result already being validated must not be written
   * after this point (context/36 section 6).
   */
  async enterManual(context: OperationContext): Promise<ControlStateView> {
    await lockControlState(context.tx);
    const state = await context.tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
    if (state.mode === 'manual') {
      return this.current(context.tx);
    }

    const frozen = await this.plans.freezeForManual(context.tx, context.now, context.actor.id);
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
    this.logger.warn(`Emergency manual mode on; Router results are no longer applied`);
    return this.current(context.tx);
  }

  /**
   * Returns to automatic control.
   *
   * Only the mode changes here. The current result is applied by the caller afterwards,
   * through the ordinary acceptance checks -- there is no merge of the manual plan with
   * the automatic one, and the manual plan stays visible until a suitable result arrives.
   */
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
    this.logger.log('Automatic mode restored; Router results are applied again');
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
