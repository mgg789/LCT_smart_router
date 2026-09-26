import { z } from 'zod';

/** Idempotent CAS request to restore the immediately preceding applied-plan revision. */
export const restorePlanSchema = z.object({
  operationId: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
export type RestorePlanDto = z.infer<typeof restorePlanSchema>;
