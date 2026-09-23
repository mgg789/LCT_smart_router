import { z } from 'zod';
import { assistedChangeSchema } from '../../routing/router-gateway/assisted.types';

/** The state shown while the dispatcher prepared this intention. */
export const assistedPreviewSchema = z.object({
  operationId: z.uuid(),
  change: assistedChangeSchema,
  expectedModeVersion: z.number().int().positive(),
  expectedPlanRevision: z.number().int().nonnegative(),
  expectedConstraintsVersion: z.number().int().positive(),
});
export type AssistedPreviewDto = z.infer<typeof assistedPreviewSchema>;

/** A separate explicit acknowledgement is required only for material consequences. */
export const assistedApplySchema = z.object({
  operationId: z.uuid(),
  proposalId: z.uuid(),
  confirmCritical: z.boolean().default(false),
  expectedPreviewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AssistedApplyDto = z.infer<typeof assistedApplySchema>;

export const assistedCancelSchema = z.object({ operationId: z.uuid(), proposalId: z.uuid() });
export type AssistedCancelDto = z.infer<typeof assistedCancelSchema>;
