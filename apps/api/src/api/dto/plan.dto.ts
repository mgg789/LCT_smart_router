import { z } from 'zod';

const unixSeconds = z.number().int().nonnegative();

export const operationIdSchema = z.object({ operationId: z.uuid() });

export const reportFactSchema = z.object({
  operationId: z.uuid(),
  /**
   * Arrival and start stay separate events. Being on site is not performing the work, so
   * an engineer who cannot begin reports `arrived_blocked` and nothing moves to
   * in progress (context/42 DF-07).
   */
  kind: z.enum(['arrived', 'arrived_blocked', 'started', 'finished', 'problem']),
  /** When it happened, as the engineer reports it. Defaults to the moment sys received it. */
  occurredAt: unixSeconds.optional(),
  note: z.string().max(2000).nullish(),
});
export type ReportFactDto = z.infer<typeof reportFactSchema>;

export const setModeSchema = z.object({
  operationId: z.uuid(),
  mode: z.enum(['auto', 'manual']),
});
export type SetModeDto = z.infer<typeof setModeSchema>;

export const reassignSchema = z.object({
  operationId: z.uuid(),
  requestId: z.string().min(1),
  engineerId: z.string().min(1),
});
export type ReassignDto = z.infer<typeof reassignSchema>;

export const reorderSchema = z.object({
  operationId: z.uuid(),
  engineerId: z.string().min(1),
  /** The finished order of one queue, saved once per completed drop (context/39 DB5). */
  requestIds: z.array(z.string().min(1)).min(1),
});
export type ReorderDto = z.infer<typeof reorderSchema>;

/**
 * A result package pushed in for testing and for the demo contour.
 *
 * The production path is the opposite direction -- sys polls Router -- so this endpoint
 * exists only while that client does not, and it runs the identical acceptance checks.
 * It is validated against the contract like any other result.
 */
export const submitResultSchema = z.object({
  operationId: z.uuid(),
  result: z.unknown(),
  activeContextVersion: z.string().min(1).nullish(),
});
export type SubmitResultDto = z.infer<typeof submitResultSchema>;
