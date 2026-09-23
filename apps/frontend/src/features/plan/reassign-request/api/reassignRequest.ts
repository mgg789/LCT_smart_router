import { authorizedRequest } from '@/entities/session';
import { newOperationId } from '@/shared/lib';

export interface ReassignRequestInput {
  requestId: string;
  engineerId: string;
}

/**
 * `POST /dispatch/plan/reassign` — moves work that has not started to another
 * crew. It belongs to MANUAL: in AUTO the System Layer answers `MODE_AUTO`.
 */
export function reassignRequest(input: ReassignRequestInput): Promise<unknown> {
  return authorizedRequest('/dispatch/plan/reassign', {
    method: 'POST',
    body: { operationId: newOperationId(), ...input },
  });
}
