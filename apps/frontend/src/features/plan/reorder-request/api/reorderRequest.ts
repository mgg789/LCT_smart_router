import { authorizedRequest } from '@/entities/session';
import { newOperationId } from '@/shared/lib';

export interface ReorderRequestInput {
  engineerId: string;
  /** Every editable job of this engineer, in the order to save. */
  requestIds: string[];
  expectedModeVersion: number;
  expectedPlanRevision: number;
}

/** Saves the complete editable MANUAL queue while keeping protected jobs in place. */
export function reorderRequest(input: ReorderRequestInput): Promise<unknown> {
  return authorizedRequest('/dispatch/plan/reorder', {
    method: 'POST',
    body: { operationId: newOperationId(), ...input },
  });
}
