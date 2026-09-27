import { z } from 'zod';
import type { DataUploadFile } from '../api/types';
import { t } from '../i18n';

const regionSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9_]{2,64}$/, t('validation.region'));
const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

const uploadRequestSchema = coordinateSchema
  .extend({
    externalId: z.string().min(1).max(200),
    addressText: z.string().min(1).max(1000),
    serviceDurationSec: z.number().int().positive(),
    windowStartAt: z.number().int().nonnegative(),
    windowEndAt: z.number().int().nonnegative(),
    priority: z.enum(['normal', 'urgent']),
    requiredSkill: z.enum(['local', 'connection', 'emergency']),
    requiredTransport: z.enum(['car', 'walk', 'bike', 'transit']).optional(),
    requiredEquipment: z.enum(['router', 'set_top_box', 'smart_speaker']).optional(),
    workType: z.string().min(1).max(200).optional(),
    workCategory: z.enum(['emergency', 'connection', 'service']).optional(),
    receivedAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => value.windowEndAt >= value.windowStartAt, {
    message: t('domain.dataUpload.3bb1728884'),
    path: ['windowEndAt'],
  });

const uploadEngineerSchema = z
  .object({
    externalId: z.string().min(1).max(200),
    displayName: z.string().min(1).max(300),
    skills: z.array(z.enum(['local', 'connection', 'emergency'])).min(1),
    transportType: z.enum(['car', 'walk', 'bike', 'transit']),
    start: coordinateSchema.strict(),
    shiftStartAt: z.number().int().nonnegative(),
    shiftEndAt: z.number().int().nonnegative(),
    equipmentStock: z
      .object({
        router: z.number().int().nonnegative().max(100),
        setTopBox: z.number().int().nonnegative().max(100),
        smartSpeaker: z.number().int().nonnegative().max(100),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.shiftEndAt > value.shiftStartAt, {
    message: t('domain.dataUpload.232d772225'),
    path: ['shiftEndAt'],
  });

/** Shared runtime validator for canonical JSON packages returned by imports. */
export const uploadFileSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    mode: z.enum(['new_region', 'append_requests']),
    region: regionSchema,
    sourceVersion: z.string().min(1).max(200),
    requests: z.array(uploadRequestSchema).min(1),
    engineers: z.array(uploadEngineerSchema).min(1).optional(),
    depot: coordinateSchema
      .extend({ addressText: z.string().min(1).max(1000) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === 'new_region' && (!value.engineers || !value.depot)) {
      context.addIssue({
        code: 'custom',
        message: t('domain.dataUpload.6c19a6cfd0'),
      });
    }
    if (value.mode === 'append_requests' && (value.engineers || value.depot)) {
      context.addIssue({
        code: 'custom',
        message: t('domain.dataUpload.b9b32bb173'),
      });
    }
    addDuplicateIssues(value.requests, 'requests', context);
    addDuplicateIssues(value.engineers ?? [], 'engineers', context);
    value.engineers?.forEach((engineer, index) => {
      if (new Set(engineer.skills).size !== engineer.skills.length) {
        context.addIssue({
          code: 'custom',
          message: t('domain.dataUpload.277b54e54b'),
          path: ['engineers', index, 'skills'],
        });
      }
    });
  });

export type DataUploadValidation =
  | { readonly ok: true; readonly file: DataUploadFile }
  | { readonly ok: false; readonly issues: string[] };

/** Parses JSON text and validates the complete upload package before network I/O. */
export function parseDataUpload(text: string): DataUploadValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [t('domain.dataUpload.8385b327b7')] };
  }
  const parsed = uploadFileSchema.safeParse(raw, { error: z.locales.ru().localeError });
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      }),
    };
  }
  return { ok: true, file: parsed.data };
}

function addDuplicateIssues(
  items: ReadonlyArray<{ readonly externalId: string }>,
  path: 'requests' | 'engineers',
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.externalId)) {
      context.addIssue({
        code: 'custom',
        message: t('validation.duplicateId', { id: item.externalId }),
        path: [path, index, 'externalId'],
      });
    }
    seen.add(item.externalId);
  }
}
