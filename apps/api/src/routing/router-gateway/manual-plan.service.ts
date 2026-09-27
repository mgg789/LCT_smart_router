import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { OperationContext } from '../../operations';
import { ManualDecisionsService } from './manual-decisions.service';
import { readManualState } from './manual-state';

/** Legacy assignment entry point now records a durable intent instead of editing route ETAs. */
@Injectable()
export class ManualPlanService {
  constructor(private readonly decisions: ManualDecisionsService) {}

  /** Saves an assignment preference; Router will compute its feasible timing. */
  async reassign(context: OperationContext, requestId: string, toEngineerId: string) {
    const state = await readManualState(context.tx);
    return this.decisions.put(context, state.version, {
      kind: 'assignment',
      targetId: requestId,
      engineerId: toEngineerId,
    });
  }

  /** Arbitrary stale route order cannot bypass prioritized constraints. */
  async reorder(
    _context: OperationContext,
    _engineerId: string,
    _orderedRequestIds: string[],
  ): Promise<never> {
    throw SysError.validationFailed(
      'Используйте панель «Приоритеты» для изменения порядка ручных решений',
    );
  }
}
