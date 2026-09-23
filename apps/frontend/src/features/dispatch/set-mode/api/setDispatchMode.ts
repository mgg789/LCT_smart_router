import type { DispatchMode } from '@/entities/plan';
import { authorizedRequest } from '@/entities/session';
import { newOperationId } from '@/shared/lib';

export interface SetDispatchModeResult {
  control: { mode: DispatchMode; modeVersion: number };
}

export interface SetDispatchModeInput {
  mode: DispatchMode;
  expectedModeVersion: number;
  expectedPlanRevision: number;
  reason?: string;
}

/**
 * `POST /dispatch/mode` — in MANUAL the System Layer stops applying router
 * results. Both transitions use current version guards; entering MANUAL requires a reason.
 */
export function setDispatchMode(input: SetDispatchModeInput): Promise<SetDispatchModeResult> {
  return authorizedRequest<SetDispatchModeResult>('/dispatch/mode', {
    method: 'POST',
    body: { operationId: newOperationId(), ...input },
  });
}
