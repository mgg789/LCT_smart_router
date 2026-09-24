import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { ControlMode } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../mount-data-eng';
import { type PlanExpectation, transitionControl } from './control-transition';

export interface ControlStateView {
  readonly mode: ControlMode;
  readonly modeVersion: number;
  readonly changedAt: number;
  readonly frozenPlanId: string | null;
}

/**
 * AUTO, assisted corrections, and emergency MANUAL.
 *
 * Emergency manual control disconnects exactly one thing: the delivery of Router's result
 * into sys. It does not stop Router, the reading of the sector, the intake of requests,
 * sign-in or actual events. Router keeps computing; its answers simply stay inside
 * Router (context/32 section 7.1).
 *
 * Returning to AUTO is an explicit transition, not an ordinary re-read. The current
 * result replaces the *future* manual distribution; it does not merge with it and does not
 * undo anything that already happened (context/32 section 7.3).
 * Assisted control leaves automatic acceptance active and retains explicit pins on exit.
 */
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

  /**
   * Switches to manual control.
   *
   * The plan in force is frozen as the starting point, and from then on the dispatcher is
   * its author. The lock matters: a result already being validated must not be written
   * after this point (context/36 section 6).
   */
  async enterManual(
    context: OperationContext,
    reason: string | undefined,
    expected: PlanExpectation,
  ): Promise<ControlStateView> {
    await transitionControl(context, 'manual', reason, expected);
    this.logger.warn(`Emergency manual mode on; Router results are no longer applied`);
    return this.current(context.tx);
  }

  /** Enables dispatcher edits while automatic calculation and application remain active. */
  async enterAssisted(
    context: OperationContext,
    reason: string | undefined,
    expected: PlanExpectation,
  ): Promise<ControlStateView> {
    const current = await this.current(context.tx);
    if (current.mode === 'manual')
      throw new SysError('MODE_MANUAL', 'Restore AUTO before opening assisted corrections');
    await transitionControl(context, 'assisted', reason, expected);
    return this.current(context.tx);
  }

  /**
   * Returns to automatic control.
   *
   * Only the mode changes here. The current result is applied by the caller afterwards,
   * through the ordinary acceptance checks -- there is no merge of the manual plan with
   * the automatic one, and the manual plan stays visible until a suitable result arrives.
   */
  async returnToAuto(
    context: OperationContext,
    expected: PlanExpectation,
  ): Promise<ControlStateView> {
    await transitionControl(context, 'auto', undefined, expected);
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.CONTROL_AUTO_RESTORED,
    );
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
