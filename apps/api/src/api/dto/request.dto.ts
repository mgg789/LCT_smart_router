import { z } from 'zod';
import { WORK_TYPE_CODES } from '../../orchestrator/requests';

/**
 * Request shapes for the request lifecycle.
 *
 * Every absolute moment is an integer number of Unix seconds. A local date is converted at
 * the edge, by the client, and never by adding an offset on the server (context/33
 * section 4).
 */

const unixSeconds = z.number().int().nonnegative();

/**
 * Fields the operation envelope adds to every change (context/36 section 12).
 *
 * `operationId` makes a retry safe; `expectedVersion` is supplied when the action follows
 * from having read the object, so that a concurrent edit surfaces as a conflict instead of
 * being overwritten.
 */
export const operationEnvelopeSchema = z.object({
  operationId: z.uuid(),
  expectedVersion: z.number().int().positive().optional(),
});

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const equipmentType = z.enum(['router', 'set_top_box', 'smart_speaker']);

export const prepareRequestSchema = operationEnvelopeSchema.extend({
  /** Required for an integration key, refused for a session: a session prepares the
   * request for its own account, a key names the customer by address
   * (context/41 sections 3.2 and 10). */
  clientEmail: z.email().optional(),
  contactName: z.string().min(1).max(200),
  addressText: z.string().min(1).max(500),
  /**
   * Optional. Without a point the request is stored and marked as needing geocoding; it
   * is then excluded from the published snapshot with a counted diagnostic rather than
   * being given invented coordinates.
   */
  lat: latitude.nullish(),
  lon: longitude.nullish(),
  /** One of the known types of work; the skill and duration follow from it. */
  workType: z.enum(WORK_TYPE_CODES as [string, ...string[]]),
  /** Optional portable equipment consumed by the visit. */
  requiredEquipment: equipmentType.nullish(),
  windowStartAt: unixSeconds,
  windowEndAt: unixSeconds,
  /** The customer's own urgency. It can raise the priority, never lower it. */
  urgent: z.boolean().default(false),
  problemText: z.string().max(2000).nullish(),
});
export type PrepareRequestDto = z.infer<typeof prepareRequestSchema>;

export const submitRequestSchema = operationEnvelopeSchema;
export type SubmitRequestDto = z.infer<typeof submitRequestSchema>;

export const rescheduleRequestSchema = operationEnvelopeSchema.extend({
  windowStartAt: unixSeconds,
  windowEndAt: unixSeconds,
});
export type RescheduleRequestDto = z.infer<typeof rescheduleRequestSchema>;

export const dispatcherCreateRequestSchema = prepareRequestSchema.extend({
  /** The client this request belongs to, by address. Machine calls select the object;
   * they do not prove that its owner confirmed anything (context/41 section 10). */
  clientEmail: z.email(),
});
export type DispatcherCreateRequestDto = z.infer<typeof dispatcherCreateRequestSchema>;

export const dispatcherUpdateRequestSchema = operationEnvelopeSchema
  .extend({
    windowStartAt: unixSeconds.optional(),
    windowEndAt: unixSeconds.optional(),
    addressText: z.string().min(1).max(500).optional(),
    lat: latitude.nullish(),
    lon: longitude.nullish(),
    urgent: z.boolean().optional(),
    requiredEquipment: equipmentType.nullish(),
  })
  .refine(
    (value) =>
      value.windowStartAt !== undefined ||
      value.windowEndAt !== undefined ||
      value.addressText !== undefined ||
      value.lat !== undefined ||
      value.lon !== undefined ||
      value.urgent !== undefined ||
      value.requiredEquipment !== undefined,
    { message: 'Nothing to change' },
  );
export type DispatcherUpdateRequestDto = z.infer<typeof dispatcherUpdateRequestSchema>;

export const cancelRequestSchema = operationEnvelopeSchema.extend({
  reason: z.string().max(500).nullish(),
});
export type CancelRequestDto = z.infer<typeof cancelRequestSchema>;

export const notificationSettingsSchema = operationEnvelopeSchema.extend({
  enabled: z.boolean(),
});
export type NotificationSettingsDto = z.infer<typeof notificationSettingsSchema>;
