/** Reward decision produced from explicit LIVE facts and a durable promise snapshot. */
export interface RewardPolicyInput {
  readonly actualAt: number;
  readonly plannedAt: number;
  readonly windowStartAt?: number;
  readonly promiseAt?: number | null;
  readonly promiseRecordedAt?: number | null;
  readonly baselineAt?: number | null;
  readonly actionRecordedAt: number;
  readonly ownerMatches?: boolean;
  /** Explicit first delay promises may be accepted after the original norm. */
  readonly allowAfterBaseline?: boolean;
}

export interface RewardPolicyDecision {
  readonly points: number;
  readonly kind: 'ordinary' | 'revised';
  readonly corridorSec?: number;
}

const REVISED_CORRIDOR_SEC = 10 * 60;

/** Returns the arrival reward; null means the explicit arrival was not accurate enough. */
export function arrivalReward(input: RewardPolicyInput): RewardPolicyDecision | null {
  const ordinary =
    input.actualAt >= (input.windowStartAt ?? Number.NEGATIVE_INFINITY) &&
    input.actualAt <= input.plannedAt;
  if (ordinary) return { points: 40, kind: 'ordinary' };
  if (!validRevisedPromise(input)) return null;
  const promiseAt = input.promiseAt;
  if (promiseAt === null || promiseAt === undefined) return null;
  if (input.actualAt >= promiseAt - REVISED_CORRIDOR_SEC && input.actualAt <= promiseAt)
    return { points: 30, kind: 'revised', corridorSec: REVISED_CORRIDOR_SEC };
  return null;
}

/** Returns the completion reward; null means the explicit finish missed both contracts. */
export function completionReward(input: RewardPolicyInput): RewardPolicyDecision | null {
  if (input.actualAt <= input.plannedAt) return { points: 40, kind: 'ordinary' };
  if (!validRevisedPromise(input)) return null;
  const promiseAt = input.promiseAt;
  if (promiseAt === null || promiseAt === undefined) return null;
  if (input.actualAt >= promiseAt - REVISED_CORRIDOR_SEC && input.actualAt <= promiseAt)
    return { points: 30, kind: 'revised', corridorSec: REVISED_CORRIDOR_SEC };
  return null;
}

function validRevisedPromise(input: RewardPolicyInput): boolean {
  return (
    input.promiseAt !== null &&
    input.promiseAt !== undefined &&
    input.promiseRecordedAt !== null &&
    input.promiseRecordedAt !== undefined &&
    input.baselineAt !== null &&
    input.baselineAt !== undefined &&
    (input.allowAfterBaseline === true || input.promiseRecordedAt < input.baselineAt) &&
    input.promiseRecordedAt < input.actionRecordedAt &&
    input.ownerMatches !== false
  );
}
