import {
  type AssistedApplyOutcome,
  type AssistedChange,
  type AssistedProposal,
  type AssistedState,
  assistedProposalSchema,
} from '@/entities/dispatcher-constraints';
import { authorizedRequest } from '@/entities/session';
import { newOperationId } from '@/shared/lib';

/** Ask the server to calculate consequences; clients do not supply candidate plans. */
export async function prepareCorrection(
  change: AssistedChange,
  state: AssistedState,
): Promise<AssistedProposal> {
  return assistedProposalSchema.parse(
    await authorizedRequest('/dispatch/assisted/preview', {
      method: 'POST',
      body: {
        operationId: newOperationId(),
        change,
        expectedModeVersion: state.modeVersion,
        expectedPlanRevision: state.planRevision,
        expectedConstraintsVersion: state.constraintsVersion,
      },
    }),
  );
}

/** Acknowledge the exact review card the dispatcher saw, including its risk decision. */
export function applyCorrection(
  proposal: AssistedProposal,
  confirmCritical: boolean,
): Promise<AssistedApplyOutcome> {
  return authorizedRequest('/dispatch/assisted/apply', {
    method: 'POST',
    body: {
      operationId: newOperationId(),
      proposalId: proposal.proposalId,
      expectedPreviewFingerprint: proposal.previewFingerprint,
      confirmCritical,
    },
  });
}

/** Discard only the proposal; the server preserves current assignments and pins. */
export function cancelCorrection(
  proposalId: string,
): Promise<{ proposalId: string; state: 'cancelled' }> {
  return authorizedRequest('/dispatch/assisted/cancel', {
    method: 'POST',
    body: { operationId: newOperationId(), proposalId },
  });
}
