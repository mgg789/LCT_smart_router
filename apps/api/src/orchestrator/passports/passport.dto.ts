import { z } from 'zod';

/** Validated engineer form; optional notes are bounded and stored as strings. */
export const passportWriteSchema = z.object({
  operationId: z.uuid(),
  connectionType: z.enum(['fiber', 'ethernet', 'dsl', 'radio', 'other']),
  difficulty: z.number().int().min(1).max(3),
  equipment: z.string().trim().max(2_000).optional().default(''),
  accessNotes: z.string().trim().max(2_000).optional().default(''),
  comment: z.string().trim().max(2_000).optional().default(''),
});

/** Input to the idempotent passport save operation. */
export type PassportWriteDto = z.infer<typeof passportWriteSchema>;
