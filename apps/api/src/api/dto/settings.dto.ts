import { z } from 'zod';
import { dispatcherSettingsPatchSchema } from '../../orchestrator/settings/dispatcher-settings';
import { operationEnvelopeSchema } from './request.dto';

/** Dispatcher operational settings replacement. Omitted keys stay; empty map keys clear. */
export const updateDispatcherSettingsSchema = operationEnvelopeSchema.merge(
  dispatcherSettingsPatchSchema,
);
export type UpdateDispatcherSettingsDto = z.infer<typeof updateDispatcherSettingsSchema>;

/** Distinct dataset addresses. The geocoder does not fall through to another provider. */
export const geocodeDatasetSchema = z.object({
  addresses: z.array(z.string().trim().min(3).max(500)).min(1).max(400),
});
export type GeocodeDatasetDto = z.infer<typeof geocodeDatasetSchema>;
