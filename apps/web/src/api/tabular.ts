import type {
  TabularAnalysis,
  TabularCompletionOptions,
  TabularConversion,
  TabularFileInput,
} from '@lct/shared';
import { z } from 'zod';
import { uploadFileSchema } from '../domain/dataUpload';
import { requestJson } from './client';

const tabularFieldSchema = z.enum([
  'externalId',
  'addressText',
  'lat',
  'lon',
  'workType',
  'duration',
  'windowStart',
  'windowEnd',
  'priority',
  'requiredSkill',
  'brigade',
  'transportType',
  'requiredTransport',
]);

const tabularAnalysisSchema = z.object({
  sourceHash: z.string().min(1),
  format: z.enum(['csv', 'tsv', 'xlsx']),
  encoding: z.string(),
  delimiter: z.string().nullable(),
  sheetNames: z.array(z.string()),
  selectedSheet: z.number().int().positive(),
  headerRow: z.number().int().positive(),
  headers: z.array(z.string()),
  rows: z.array(z.object({ rowNumber: z.number().int().positive(), values: z.array(z.string()) })),
  columns: z.partialRecord(tabularFieldSchema, z.number().int().nonnegative()),
  missing: z.array(z.object({ field: tabularFieldSchema, count: z.number().int().nonnegative() })),
  officeAddress: z.string().nullable(),
  notices: z.array(z.string()),
  durationUnit: z.enum(['minutes', 'seconds']),
});

const tabularConversionSchema = z.object({
  file: uploadFileSchema.nullable(),
  issues: z.array(
    z.object({
      rowNumber: z.number().int().positive().nullable(),
      field: z.union([tabularFieldSchema, z.enum(['depot', 'engineers', 'workDate'])]),
      message: z.string(),
    }),
  ),
  notices: z.array(z.string()),
});

/** Analyze a bounded tabular payload without importing or mutating dispatcher data. */
export function analyzeTabular(token: string, input: TabularFileInput): Promise<TabularAnalysis> {
  return requestJson<TabularAnalysis>(
    '/api/v1/dispatch/data/tabular/analyze',
    tabularAnalysisSchema,
    token,
    { method: 'POST', body: JSON.stringify(input) },
    60_000,
  );
}

/** Convert reviewed tabular rows into the canonical JSON upload package. */
export function convertTabular(
  token: string,
  source: TabularFileInput,
  options: TabularCompletionOptions,
): Promise<TabularConversion> {
  return requestJson<TabularConversion>(
    '/api/v1/dispatch/data/tabular/convert',
    tabularConversionSchema,
    token,
    { method: 'POST', body: JSON.stringify({ source, options }) },
    60_000,
  );
}
