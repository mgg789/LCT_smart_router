import { z } from 'zod';
import { dispatcherSettingsPatchSchema } from '../../orchestrator/settings/dispatcher-settings';
import { operationEnvelopeSchema } from './request.dto';

/** Dispatcher operational settings replacement. Omitted keys stay; empty map keys clear. */
export const updateDispatcherSettingsSchema = operationEnvelopeSchema.merge(
  dispatcherSettingsPatchSchema,
);
export type UpdateDispatcherSettingsDto = z.infer<typeof updateDispatcherSettingsSchema>;
