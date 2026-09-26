import { z } from 'zod';

const policyId = z.enum(['fast', 'compact', 'sla', 'balanced', 'eco', 'covering']);

/** What-if patch. A free snapshot is not accepted. */
export const simulationPatchSchema = z
  .object({
    catalog: z.boolean().optional(),
    policyId: policyId.optional(),
    lunchesEnabled: z.boolean().optional(),
    metroEnabled: z.boolean().optional(),
    trafficEnabled: z.boolean().optional(),
    equipmentEnabled: z.boolean().optional(),
    equipmentTransfersEnabled: z.boolean().optional(),
    bringOnlineEngineerId: z.string().min(1).optional(),
    window: z
      .object({
        requestId: z.string().min(1),
        windowStartAt: z.number().int().nonnegative(),
        windowEndAt: z.number().int().nonnegative(),
      })
      .optional(),
    pin: z
      .object({
        requestId: z.string().min(1),
        engineerId: z.string().min(1),
      })
      .optional(),
    unassignRequestId: z.string().min(1).optional(),
  })
  .strict();

export type SimulationPatchDto = z.infer<typeof simulationPatchSchema>;
