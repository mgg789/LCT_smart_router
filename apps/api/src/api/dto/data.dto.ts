import { z } from 'zod';

const datasetRegion = z.enum(['east', 'southeast', 'south_central']);
const engineerCount = z.number().int().positive().max(1000);

export const importDatasetSchema = z
  .object({
    operationId: z.uuid(),
    /** Backwards-compatible single-region selector. */
    region: datasetRegion.optional(),
    /** A selected set, or every official region in canonical order. */
    regions: z.union([z.literal('all'), z.array(datasetRegion).min(1)]).optional(),
    /** Optional deterministic crew cap for benchmark and capacity scenarios. */
    engineerCountPerRegion: z.partialRecord(datasetRegion, engineerCount).optional(),
  })
  .superRefine((value, context) => {
    if ((value.region === undefined) === (value.regions === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Provide exactly one of region or regions',
        path: ['regions'],
      });
    }
    if (Array.isArray(value.regions) && new Set(value.regions).size !== value.regions.length) {
      context.addIssue({ code: 'custom', message: 'Regions must be unique', path: ['regions'] });
    }
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
