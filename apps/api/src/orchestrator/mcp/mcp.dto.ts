import { z } from 'zod';
import { operationEnvelopeSchema } from '../../api/dto/request.dto';

/**
 * Dashboard → MCP settings. The pin travels here exactly once, from the dispatcher's
 * browser to the server, and is immediately reduced to a hash of an `ApiToken` row.
 */
export const updateMcpSettingsSchema = operationEnvelopeSchema.extend({
  enabled: z.boolean(),
  pin: z.string().max(128).optional(),
});
export type UpdateMcpSettingsDto = z.infer<typeof updateMcpSettingsSchema>;
