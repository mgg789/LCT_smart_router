import type { DispatchMode } from '@/entities/plan';
import { authorizedRequest } from '@/entities/session';
import { newOperationId } from '@/shared/lib';

export interface SetDispatchModeResult {
  control: { mode: DispatchMode; modeVersion: number };
}

/**
 * `POST /dispatch/mode` — in MANUAL the System Layer stops applying router
 * results; the Router keeps calculating, its output just is not taken up.
 */
export function setDispatchMode(mode: DispatchMode): Promise<SetDispatchModeResult> {
  return authorizedRequest<SetDispatchModeResult>('/dispatch/mode', {
    method: 'POST',
    body: { operationId: newOperationId(), mode },
  });
}
