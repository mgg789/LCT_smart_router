import { z } from 'zod';
import { requestJson } from './client';

export const REWARD_LABELS = {
  arrival: 'Точное прибытие',
  completion: 'Работа в срок',
  passport: 'Паспорта объектов',
  penalty: 'Подтверждённые нарушения',
} as const;
const categories = z.object({
  arrival: z.number(),
  completion: z.number(),
  passport: z.number(),
  penalty: z.number(),
});
const entry = z.object({
  id: z.string(),
  requestId: z.string().nullable(),
  workdayId: z.string().nullable(),
  category: z.enum(['arrival', 'completion', 'passport', 'penalty']),
  points: z.number().int(),
  awardedAt: z.number(),
  reason: z.string(),
});
/** Wall-calendar month totals include the separately audited manual adjustments. */
export const rewardsSchema = z.object({
  month: z.string(),
  monthlyPoints: z.number().int(),
  earnedPoints: z.number(),
  penaltyPoints: z.number(),
  teamAverage: z.number().nullable(),
  teamRatio: z.number().nullable(),
  categories,
  recentEntries: z.array(entry),
});
export const rewardDaySchema = z.object({
  workdayId: z.string(),
  workDate: z.string(),
  monthlyPoints: z.number(),
  earnedPoints: z.number(),
  penaltyPoints: z.number(),
  categories,
  entries: z.array(entry),
});
export type RewardSummary = z.infer<typeof rewardsSchema>;
export type RewardDaySummary = z.infer<typeof rewardDaySchema>;

/** Reads own reward history, or a dispatcher-authorized engineer dossier. */
export function loadRewards(token: string, engineerId?: string) {
  return requestJson(
    engineerId
      ? `/api/v1/dispatch/engineers/${encodeURIComponent(engineerId)}/rewards`
      : '/api/v1/engineer/rewards',
    rewardsSchema,
    token,
  );
}
/** Uses the immutable workday identity, so a day switch never mixes results. */
export function loadRewardDay(token: string, workdayId: string) {
  return requestJson(
    `/api/v1/engineer/rewards/day?workdayId=${encodeURIComponent(workdayId)}`,
    rewardDaySchema,
    token,
  );
}

/** Keeps zero/negative team means explicit rather than displaying an invalid ratio. */
export function rewardRatioLabel(ratio: number | null): string {
  return ratio === null
    ? 'Сравнение появится с первыми баллами команды'
    : `${ratio.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}× среднего команды`;
}

const rewardFactsSchema = z.object({
  facts: z.array(
    z.object({
      id: z.string(),
      requestId: z.string(),
      kind: z.string(),
      occurredAt: z.number(),
      note: z.string().nullable(),
      request: z.object({ addressText: z.string() }),
    }),
  ),
});
export type RewardFact = z.infer<typeof rewardFactsSchema>['facts'][number];
/** Lists explicit evidence; the server excludes facts already penalized. */
export function loadRewardFacts(token: string, engineerId: string) {
  return requestJson(
    `/api/v1/dispatch/engineers/${encodeURIComponent(engineerId)}/reward-facts`,
    rewardFactsSchema,
    token,
  );
}
/** Records one dispatcher decision; preserve operationId when retrying transport failures. */
export function penalizeReward(
  token: string,
  engineerId: string,
  input: { operationId: string; requestId: string; factId: string; reason: string },
) {
  return requestJson(
    `/api/v1/dispatch/engineers/${encodeURIComponent(engineerId)}/rewards/penalty`,
    z.unknown(),
    token,
    { method: 'POST', body: JSON.stringify({ ...input, engineerId }) },
  );
}
