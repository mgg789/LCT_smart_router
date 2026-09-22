import { describe, expect, it } from 'vitest';
import { shouldShowDayResults } from './performance';
import { rewardRatioLabel, rewardsSchema } from './rewards';

describe('reward and day-end UI contracts', () => {
  it('opens day results only after execution and the last blocking alert are finished', () => {
    expect(shouldShowDayResults('running', 0, null)).toBe(false);
    expect(shouldShowDayResults('finished', 1, null)).toBe(false);
    expect(shouldShowDayResults('finished', 0, null)).toBe(true);
    expect(shouldShowDayResults('finished', 0, 1234)).toBe(false);
    expect(shouldShowDayResults('finished', undefined, undefined)).toBe(false);
  });
  it('accepts audited negative balances without treating them as failed API responses', () => {
    const data = rewardsSchema.parse({
      month: '2026-09',
      monthlyPoints: -15,
      earnedPoints: 35,
      penaltyPoints: -50,
      teamAverage: 10,
      teamRatio: -1.5,
      categories: { arrival: 0, completion: 0, passport: 35, penalty: -50 },
      recentEntries: [],
    });
    expect(data.monthlyPoints).toBe(-15);
    expect(rewardRatioLabel(data.teamRatio)).toContain('-1,5');
  });
  it('keeps an unavailable team comparison distinct from a zero relative contribution', () => {
    expect(rewardRatioLabel(null)).not.toContain('×');
    expect(rewardRatioLabel(0)).toBe('0× среднего команды');
  });
});
