import { z } from 'zod';
import type { DispatcherConstraints } from '../dispatcher-constraints';
import type { AssistedImpact } from './assisted-impact';

export const ASSISTED_PROPOSAL_TTL_SEC = 5 * 60;

const id = z.string().min(1).max(128);
const uniqueIds = z
  .array(id)
  .min(1)
  .max(500)
  .refine((values) => new Set(values).size === values.length, 'Duplicate request');

/** Intent only. Clients never supply a candidate plan, impact, or approval evidence. */
export const assistedChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assign'), requestId: id, engineerId: id }),
  z.object({
    kind: z.literal('reorder'),
    engineerId: id,
    requestIds: uniqueIds.refine((values) => values.length >= 2),
  }),
  z.object({ kind: z.literal('release'), requestIds: uniqueIds }),
  z.object({ kind: z.literal('release_all') }),
  z.object({ kind: z.literal('replan') }),
]);
export type AssistedChange = z.infer<typeof assistedChangeSchema>;

export interface AssistedVersions {
  expectedModeVersion: number;
  expectedPlanRevision: number;
  expectedConstraintsVersion: number;
}

export interface AssistedBlocker {
  code: string;
  message: string;
  requestIds: string[];
  engineerIds: string[];
}

/** Public review card, deliberately excluding the private raw Router package. */
export interface AssistedProposalView {
  proposalId: string;
  previewFingerprint: string;
  source: 'dispatcher' | 'automatic';
  state: string;
  createdAt: number;
  expiresAt: number;
  canApply: boolean;
  requiresConfirmation: boolean;
  versions: AssistedVersions;
  change: AssistedChange;
  constraints: DispatcherConstraints;
  impact: AssistedImpact;
  blockers: AssistedBlocker[];
}
