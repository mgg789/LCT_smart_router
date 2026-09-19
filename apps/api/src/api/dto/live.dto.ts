import { z } from 'zod';
import { operationEnvelopeSchema } from './request.dto';

const requestId = z.string().min(1);
const note = z.string().trim().min(1).max(2_000);

/** Starts the one durable LIVE session for the current dispatcher workday. */
export const startLiveWorkdaySchema = operationEnvelopeSchema;
export type StartLiveWorkdayDto = z.infer<typeof startLiveWorkdaySchema>;

/**
 * Engineer LIVE actions. Timestamps are intentionally absent: the System Layer derives
 * them from the durable business clock, so an accelerated demo cannot be spoofed by a
 * browser wall clock.
 */
export const liveActionSchema = z.discriminatedUnion('kind', [
  operationEnvelopeSchema.extend({
    kind: z.literal('online'),
    engineerId: z.string().min(1).optional(),
  }),
  operationEnvelopeSchema.extend({
    kind: z.literal('on_time'),
    engineerId: z.string().min(1).optional(),
    requestId,
  }),
  operationEnvelopeSchema.extend({
    kind: z.literal('eta'),
    engineerId: z.string().min(1).optional(),
    requestId,
    etaAt: z.number().int().nonnegative(),
  }),
  operationEnvelopeSchema.extend({
    kind: z.literal('start'),
    engineerId: z.string().min(1).optional(),
    requestId,
  }),
  operationEnvelopeSchema.extend({
    kind: z.literal('finish'),
    engineerId: z.string().min(1).optional(),
    requestId,
  }),
  operationEnvelopeSchema.extend({
    kind: z.literal('problem'),
    engineerId: z.string().min(1).optional(),
    requestId,
    problemKind: z.enum(['delay', 'missing_equipment', 'other', 'impossible']),
    note,
    additionalDurationSec: z.number().int().positive().max(86_400).optional(),
    missingEquipment: z.enum(['router', 'set_top_box', 'smart_speaker']).optional(),
  }),
  operationEnvelopeSchema.extend({
    kind: z.literal('break_start'),
    engineerId: z.string().min(1).optional(),
  }),
  operationEnvelopeSchema.extend({
    kind: z.literal('break_finish'),
    engineerId: z.string().min(1).optional(),
  }),
]);

export type LiveActionDto = z.infer<typeof liveActionSchema>;
