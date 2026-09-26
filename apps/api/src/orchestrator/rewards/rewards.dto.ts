import { z } from 'zod';

/** Dispatcher-only manual penalty request; the reason is part of the audit contract. */
export const rewardPenaltySchema = z.object({
  operationId: z.uuid(),
  engineerId: z.string().min(1),
  requestId: z.string().min(1),
  factId: z.string().min(1),
  reason: z.string().trim().min(30).max(2_000),
});

export type RewardPenaltyDto = z.infer<typeof rewardPenaltySchema>;
