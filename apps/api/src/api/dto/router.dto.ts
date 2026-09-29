import { z } from 'zod';

const toleranceSeconds = z.number().int().nonnegative().max(86_400);

/** On/off switch for the Redis-beta route-response cache. */
export const routeCacheSwitchSchema = z.object({
  enabled: z.boolean(),
});
export type RouteCacheSwitchDto = z.infer<typeof routeCacheSwitchSchema>;

/** Complete Router-owned settings replacement with context-version CAS. */
export const updateRouterTechnicalSettingsSchema = z.object({
  operationId: z.uuid(),
  expectedContextVersion: z.string().min(1),
  strictTimeWindows: z.boolean().optional(),
  lunchesEnabled: z.boolean(),
  departureLatenessToleranceSec: toleranceSeconds,
  taskStartLatenessToleranceSec: toleranceSeconds,
  windowLatenessToleranceSec: z.number().int().nonnegative().max(1_200).optional(),
  trafficEnabled: z.boolean().optional(),
  metroEnabled: z.boolean().optional(),
  equipmentTransfersEnabled: z.boolean().optional(),
  equipmentEnabled: z.boolean().optional(),
  travelTimeMode: z.enum(['graph_with_access_buffer', 'fixed_normative']),
  accessBufferSec: toleranceSeconds,
  fixedTravelTimeSec: toleranceSeconds.positive(),
  earlyFinishReplanThresholdSec: toleranceSeconds,
  taskOverrunToleranceSec: toleranceSeconds,
  solveTimeLimitMs: z.number().int().min(1).max(120_000).default(6000),
  verifyTimeLimitMs: z.number().int().min(1).max(120_000).default(6000),
  comparisonTimeLimitMs: z.number().int().min(1).max(120_000).default(6000),
});
export type UpdateRouterTechnicalSettingsDto = z.infer<typeof updateRouterTechnicalSettingsSchema>;
