import { z } from 'zod';

export const importDatasetSchema = z.object({
  operationId: z.uuid(),
  /** Which region of the official dataset to load. */
  region: z.enum(['east', 'southeast', 'south_central']),
});
export type ImportDatasetDto = z.infer<typeof importDatasetSchema>;

export const resetSchema = z.object({
  operationId: z.uuid(),
  /**
   * `demo` returns to the prepared test state; `empty` gives a blank working set for
   * collecting requests from scratch. They are different actions, and neither is the
   * ordinary "add data" (context/37 section 9.2).
   */
  kind: z.enum(['demo', 'empty']),
  /**
   * The exact confirmation phrase for this action. A destructive reset always needs an
   * explicit human confirmation naming what it affects, and an AI may prepare one but
   * never confirm it on the dispatcher's behalf (context/42 DF-24).
   */
  confirmation: z.string().min(1),
});
export type ResetDto = z.infer<typeof resetSchema>;
