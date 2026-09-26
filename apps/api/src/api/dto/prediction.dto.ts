import { z } from 'zod';

/**
 * Dry Monte-Carlo prediction request for one fixed plan.
 *
 * The routes are fixed visit orders of the applied plan (identity-bound to the
 * published snapshot); a prediction never returns a plan and never changes one.
 */
export const situationPredictSchema = z.object({
  inputHash: z.string().length(64),
  routerContextVersion: z.string().min(1),
  routes: z.record(z.string().min(1), z.array(z.string().min(1))),
  simulations: z.number().int().min(100).max(2000).default(300),
  asOf: z.number().int().positive().optional(),
  completed: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
  cancelRate: z.number().min(0).max(1).optional(),
});

export type SituationPredictDto = z.infer<typeof situationPredictSchema>;
