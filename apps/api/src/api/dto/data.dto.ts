import { z } from 'zod';

const datasetRegion = z.enum(['east', 'southeast', 'south_central']);
const engineerCount = z.number().int().positive().max(1000);
const regionSlug = z.string().regex(/^[a-z0-9_]{2,64}$/);
const coordinate = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .strict();
const uploadRequest = z
  .object({
    externalId: z.string().trim().min(1).max(200),
    addressText: z.string().trim().min(1).max(1000),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    serviceDurationSec: z.number().int().positive(),
    windowStartAt: z.number().int().nonnegative(),
    windowEndAt: z.number().int().nonnegative(),
    priority: z.enum(['normal', 'urgent']),
    requiredSkill: z.enum(['local', 'connection', 'emergency']),
    requiredTransport: z.enum(['car', 'walk', 'bike', 'transit']).optional(),
    requiredEquipment: z.enum(['router', 'set_top_box', 'smart_speaker']).optional(),
    workType: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.windowEndAt >= value.windowStartAt, {
    message: 'windowEndAt must not be earlier than windowStartAt',
    path: ['windowEndAt'],
  });
const uploadEngineer = z
  .object({
    externalId: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(300),
    skills: z.array(z.enum(['local', 'connection', 'emergency'])).min(1),
    transportType: z.enum(['car', 'walk', 'bike', 'transit']),
    start: coordinate,
    shiftStartAt: z.number().int().nonnegative(),
    shiftEndAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.shiftEndAt > value.shiftStartAt, {
    message: 'shiftEndAt must be later than shiftStartAt',
    path: ['shiftEndAt'],
  });

/** Validated JSON package accepted from the Dashboard file-upload flow. */
export const uploadDataPackageSchema = z
  .object({
    operationId: z.uuid(),
    schemaVersion: z.literal('1.0'),
    mode: z.enum(['new_region', 'append_requests']),
    region: regionSlug,
    sourceVersion: z.string().trim().min(1).max(200),
    requests: z.array(uploadRequest).min(1),
    engineers: z.array(uploadEngineer).min(1).optional(),
    depot: z
      .object({
        addressText: z.string().trim().min(1).max(1000),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'new_region') {
      if (!value.engineers) {
        context.addIssue({
          code: 'custom',
          message: 'engineers are required',
          path: ['engineers'],
        });
      }
      if (!value.depot) {
        context.addIssue({ code: 'custom', message: 'depot is required', path: ['depot'] });
      }
    } else {
      if (value.engineers !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'engineers are forbidden for append_requests',
          path: ['engineers'],
        });
      }
      if (value.depot !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'depot is forbidden for append_requests',
          path: ['depot'],
        });
      }
    }
    duplicateIssues(value.requests, 'externalId', ['requests'], context);
    if (value.engineers) {
      duplicateIssues(value.engineers, 'externalId', ['engineers'], context);
      value.engineers.forEach((engineer, index) => {
        if (new Set(engineer.skills).size !== engineer.skills.length) {
          context.addIssue({
            code: 'custom',
            message: 'Engineer skills must be unique',
            path: ['engineers', index, 'skills'],
          });
        }
      });
    }
  });
export type UploadDataPackageDto = z.infer<typeof uploadDataPackageSchema>;

function duplicateIssues<T extends Record<K, string>, K extends keyof T>(
  values: readonly T[],
  key: K,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const item = value[key];
    if (seen.has(item)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate ${String(key)}: ${item}`,
        path: [...path, index, String(key)],
      });
    }
    seen.add(item);
  });
}

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
