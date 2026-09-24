import { z } from 'zod';

/** Dispatcher intentions, distinct from an automatic assignment or an execution fact. */
export const dispatcherConstraintsSchema = z.object({
  assignments: z.array(z.object({ requestId: z.string(), engineerId: z.string() })),
  orders: z.array(z.object({ engineerId: z.string(), requestIds: z.array(z.string()) })),
});
export type DispatcherConstraints = z.infer<typeof dispatcherConstraintsSchema>;

export const assistedChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assign'), requestId: z.string(), engineerId: z.string() }),
  z.object({ kind: z.literal('reorder'), engineerId: z.string(), requestIds: z.array(z.string()) }),
  z.object({ kind: z.literal('release'), requestIds: z.array(z.string()) }),
  z.object({ kind: z.literal('release_all') }),
  z.object({ kind: z.literal('replan') }),
]);
export type AssistedChange = z.infer<typeof assistedChangeSchema>;

const blockerSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestIds: z.array(z.string()),
  engineerIds: z.array(z.string()),
});
export const assistedProposalSchema = z.object({
  proposalId: z.string(),
  previewFingerprint: z.string(),
  source: z.enum(['dispatcher', 'automatic']),
  state: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  canApply: z.boolean(),
  requiresConfirmation: z.boolean(),
  versions: z.object({
    expectedModeVersion: z.number(),
    expectedPlanRevision: z.number(),
    expectedConstraintsVersion: z.number(),
  }),
  change: assistedChangeSchema,
  constraints: dispatcherConstraintsSchema,
  impact: z.object({
    assignedBefore: z.number(),
    assignedAfter: z.number(),
    lost: z.array(
      z.object({ requestId: z.string(), engineerId: z.string(), priority: z.string() }),
    ),
    moved: z.array(
      z.object({ requestId: z.string(), fromEngineerId: z.string(), toEngineerId: z.string() }),
    ),
    reorderedRoutes: z.array(
      z.object({
        engineerId: z.string(),
        beforeRequestIds: z.array(z.string()),
        afterRequestIds: z.array(z.string()),
        changedRequestIds: z.array(z.string()),
      }),
    ),
    delayed: z.array(
      z.object({
        requestId: z.string(),
        beforeStartAt: z.number(),
        afterStartAt: z.number(),
        delaySec: z.number(),
      }),
    ),
    newlyLate: z.array(
      z.object({
        requestId: z.string(),
        endAt: z.number(),
        windowEndAt: z.number(),
        latenessSec: z.number(),
      }),
    ),
    addedEngineerIds: z.array(z.string()),
    timingsCompared: z.boolean(),
    criticalReasons: z.array(z.object({ code: z.string(), entityIds: z.array(z.string()) })),
    requiresConfirmation: z.boolean(),
    fingerprint: z.string(),
  }),
  blockers: z.array(blockerSchema),
});
export type AssistedProposal = z.infer<typeof assistedProposalSchema>;

export const assistedStateSchema = z.object({
  mode: z.enum(['auto', 'manual', 'assisted']),
  modeVersion: z.number(),
  planRevision: z.number(),
  constraintsVersion: z.number(),
  constraints: dispatcherConstraintsSchema,
  pendingProposal: assistedProposalSchema.nullable(),
  blockers: z.array(blockerSchema),
  editableRequestIds: z.array(z.string()),
});
export type AssistedState = z.infer<typeof assistedStateSchema>;

export interface AssistedApplyOutcome {
  proposalId: string;
  state: 'applied';
  planRevision: number;
  constraintsVersion: number;
  impact: AssistedProposal['impact'];
}
