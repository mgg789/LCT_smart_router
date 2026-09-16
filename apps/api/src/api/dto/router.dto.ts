import { z } from 'zod';

const toleranceSeconds = z.number().int().nonnegative().max(86_400);

/** Complete Router-owned settings replacement with context-version CAS. */
export const updateRouterTechnicalSettingsSchema = z.object({
  operationId: z.uuid(),
  expectedContextVersion: z.string().min(1),
  lunchesEnabled: z.boolean(),
  departureLatenessToleranceSec: toleranceSeconds,
  taskStartLatenessToleranceSec: toleranceSeconds,
  travelTimeMode: z.enum(['graph_with_access_buffer', 'fixed_normative']),
  accessBufferSec: toleranceSeconds,
  fixedTravelTimeSec: toleranceSeconds.positive(),
  earlyFinishReplanThresholdSec: toleranceSeconds,
  taskOverrunToleranceSec: toleranceSeconds,
});
export type UpdateRouterTechnicalSettingsDto = z.infer<typeof updateRouterTechnicalSettingsSchema>;
