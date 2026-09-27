import { effectiveRoles } from '../auth/actor';
import { SysError } from '../common/errors';
import type { Tx } from '../persistence';
import {
  manualNeedsReview,
  manualStateView,
  readManualState,
} from '../routing/router-gateway/manual-state';
import type { OperationRequest } from './operation.types';

/** Freeze dispatcher planning mutations until priorities are reviewed, never LIVE/customer facts. */
export async function assertManualConflictResolved(
  tx: Tx,
  request: OperationRequest,
): Promise<void> {
  if (!effectiveRoles(request.actor).includes('dispatcher')) return;
  const action = request.action;
  if (
    [
      'engineer.attendance',
      'engineer.open_day',
      'engineer.start_lunch',
      'engineer.finish_lunch',
      'engineer.passport.save',
      'engineer.technical_break',
    ].includes(action)
  )
    return;
  if (
    action === 'manual.priorities' ||
    action === 'control.auto' ||
    action.startsWith('live.') ||
    action.startsWith('request.fact.')
  )
    return;
  if (
    !/^(manual\.|control\.|plan\.|policy\.|request\.|engineer\.|region\.|alert\.|shift\.|data\.|router\.|dispatch\.|dispatcher\.)/.test(
      action,
    )
  )
    return;
  const control = await tx.controlState.findUnique({ where: { id: 'singleton' } });
  if (control?.mode !== 'manual') return;
  const state = await readManualState(tx);
  if (manualNeedsReview(state))
    throw new SysError(
      'VALIDATION_FAILED',
      'Сначала разрешите конфликт приоритетов ручного плана.',
      { details: { kind: 'manual_conflict', manual: manualStateView(state) } },
    );
}
