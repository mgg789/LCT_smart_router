import type { PolicyId } from '@/entities/policy';
import { authorizedRequest } from '@/entities/session';
import { newOperationId } from '@/shared/lib';

export interface SelectPolicyResult {
  policyId: PolicyId;
  publication?: { publicationId: string; inputHash: string; planningAsOf: number } | null;
}

/**
 * `POST /dispatch/policy` — publishes a new task; the plan on screen changes only
 * once the router result is accepted, so callers must keep polling the plan.
 */
export function selectPolicy(policyId: PolicyId): Promise<SelectPolicyResult> {
  return authorizedRequest<SelectPolicyResult>('/dispatch/policy', {
    method: 'POST',
    body: { operationId: newOperationId(), policyId },
  });
}
