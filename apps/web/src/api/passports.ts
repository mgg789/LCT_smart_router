import { z } from 'zod';
import { requestJson } from './client';

/** Connection technologies recorded by an engineer, independent of request work type. */
export const CONNECTION_TYPES = {
  fiber: 'Оптика',
  ethernet: 'Ethernet',
  dsl: 'DSL',
  radio: 'Радиоканал',
  other: 'Другое',
} as const;

const connectionSchema = z.enum(['fiber', 'ethernet', 'dsl', 'radio', 'other']);

/** Validates the same form for first fill and an update after 45 days. */
export const passportInputSchema = z.object({
  connectionType: connectionSchema,
  difficulty: z.number().int().min(1).max(3),
  equipment: z.string().trim().max(2000),
  accessNotes: z.string().trim().max(2000),
  comment: z.string().trim().max(2000),
});

/** Passport dates are Unix seconds; staleness is decided by the server. */
export const passportStateSchema = z.object({
  passport: passportInputSchema
    .extend({
      id: z.string(),
      address: z.string(),
      updatedAt: z.number().int(),
      stale: z.boolean(),
    })
    .nullable(),
  canFill: z.boolean(),
  unavailableReason: z.string().nullable().optional(),
});

/** Monthly totals derive from persisted award history rather than a browser counter. */
export const monthlyPointsSchema = z.object({
  monthlyPoints: z.number().int(),
  month: z.string(),
});

export type PassportInput = z.infer<typeof passportInputSchema>;
export type PassportState = z.infer<typeof passportStateSchema>;
export type ObjectPassport = NonNullable<PassportState['passport']>;
export type PassportAudience = 'engineer' | 'dispatch';

/** Reads the building passport through the caller's authorized request contour. */
export function loadPassport(token: string, audience: PassportAudience, requestId: string) {
  return requestJson(
    `/api/v1/${audience}/requests/${encodeURIComponent(requestId)}/passport`,
    passportStateSchema,
    token,
  );
}

/** Keeps an operation id across transport retries to prevent duplicate awards. */
export function savePassport(
  token: string,
  requestId: string,
  operationId: string,
  input: PassportInput,
) {
  return requestJson(
    `/api/v1/engineer/requests/${encodeURIComponent(requestId)}/passport`,
    passportStateSchema.extend({
      pointsAwarded: z.number().int(),
      monthlyPoints: z.number().int(),
    }),
    token,
    { method: 'POST', body: JSON.stringify({ operationId, ...input }) },
  );
}

/** An engineer reads their own total; dispatch explicitly names the engineer. */
export function loadMonthlyPoints(token: string, engineerId?: string) {
  const path =
    engineerId === undefined
      ? '/api/v1/engineer/points'
      : `/api/v1/dispatch/engineers/${encodeURIComponent(engineerId)}/points`;
  return requestJson(path, monthlyPointsSchema, token);
}
