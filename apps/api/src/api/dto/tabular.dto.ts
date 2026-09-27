import { z } from 'zod';

const tabularFields = z.enum([
  'externalId',
  'addressText',
  'lat',
  'lon',
  'workType',
  'workCategory',
  'duration',
  'windowStart',
  'windowEnd',
  'priority',
  'requiredSkill',
  'brigade',
  'transportType',
  'requiredTransport',
]);

const fieldIndexMap = z.partialRecord(tabularFields, z.number().int().min(0).max(63));
const fieldDefaults = z.partialRecord(tabularFields, z.string().max(2_000));

/** Bounded tabular file descriptor accepted by both analysis and conversion. */
export const tabularFileInputSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    // 6 MiB decoded is 8,388,608 base64 characters; a small margin accepts padding.
    payloadBase64: z.string().min(1).max(8_500_000),
    /** Sheet number is one-based, matching the physical workbook shown to a dispatcher. */
    sheet: z.number().int().positive().max(255).optional(),
    encoding: z.enum(['auto', 'utf8', 'windows1251', 'utf16le']).optional(),
    delimiter: z.enum(['auto', ',', ';', '\t', '|']).optional(),
    /** Header row is a one-based record index in the parsed source. */
    headerRow: z.number().int().positive().max(5_000).optional(),
  })
  .strict();

const coordinate = z.number().finite();

/** Dispatcher choices used while converting a reviewed tabular preview. */
export const tabularCompletionOptionsSchema = z
  .object({
    mode: z.enum(['new_region', 'append_requests']),
    region: z
      .string()
      .trim()
      .regex(/^[a-z0-9_]{2,64}$/),
    workDate: z.string().trim().min(1).max(100),
    columns: fieldIndexMap,
    defaults: fieldDefaults,
    durationUnit: z.enum(['minutes', 'seconds']),
    depot: z
      .object({
        addressText: z.string().trim().max(1_000),
        lat: coordinate.min(-90).max(90).optional(),
        lon: coordinate.min(-180).max(180).optional(),
      })
      .strict(),
    engineers: z
      .object({
        count: z.number().int().positive().max(1_000),
        transportType: z.enum(['car', 'walk', 'bike', 'transit']),
        skills: z
          .array(z.enum(['local', 'connection', 'emergency']))
          .min(1)
          .max(3),
        shiftStart: z.string().trim().min(1).max(32),
        shiftEnd: z.string().trim().min(1).max(32),
      })
      .strict(),
    edits: z
      .array(
        z
          .object({
            rowNumber: z.number().int().positive().max(5_000),
            field: tabularFields,
            value: z.string().max(2_000),
          })
          .strict(),
      )
      .max(20_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.engineers.skills).size !== value.engineers.skills.length) {
      context.addIssue({
        code: 'custom',
        path: ['engineers', 'skills'],
        message: 'Engineer skills must be unique',
      });
    }
  });

/** Request body for a read-only tabular preview. */
export const tabularAnalyzeSchema = tabularFileInputSchema;
export type TabularAnalyzeDto = z.infer<typeof tabularAnalyzeSchema>;

/** Request body for conversion after the dispatcher reviewed the preview. */
export const tabularConvertSchema = z
  .object({
    source: tabularFileInputSchema,
    options: tabularCompletionOptionsSchema,
  })
  .strict();
export type TabularConvertDto = z.infer<typeof tabularConvertSchema>;
