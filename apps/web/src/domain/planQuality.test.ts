import { describe, expect, it } from 'vitest';
import { planQualityAdvice, qualityBand, reliableDaysOutOfTen, unroutedPlanAdvice } from './planQuality';
import { recommendPolicy } from './policyRecommend';

describe('plan quality advice', () => {
  it('uses the documented reliability bands and the dispatcher titles', () => {
    expect(qualityBand(0.9)).toBe('green');
    expect(qualityBand(0.89)).toBe('yellow');
    expect(qualityBand(0.7)).toBe('yellow');
    expect(qualityBand(0.69)).toBe('red');
    expect(reliableDaysOutOfTen(0.74)).toBe(7);
    expect(
      planQualityAdvice({
        robustness: 0.96,
        unassignedCount: 0,
        activePolicy: 'balanced',
        requests: [],
        engineers: [],
      }).title,
    ).toBe('План отличный');
    expect(
      planQualityAdvice({
        robustness: 0.74,
        unassignedCount: 0,
        activePolicy: 'balanced',
        requests: [],
        engineers: [],
      }).title,
    ).toBe('Можно работать');
    expect(
      planQualityAdvice({
        robustness: 0.4,
        unassignedCount: 0,
        activePolicy: 'balanced',
        requests: [],
        engineers: [],
      }).title,
    ).toBe('Высокий риск');
  });

  it('does not suggest the policy that is already on, and links the risky request', () => {
    const tense = planQualityAdvice({
      robustness: 0.74,
      unassignedCount: 1,
      activePolicy: 'covering',
      requests: [
        { requestId: 'ac0446e1-1', shortId: 'ac0446e1', breachProb: 0.21 },
        { requestId: 'b', shortId: 'bbbbbbbb', breachProb: 0.1 },
      ],
      engineers: [{ name: 'Михаил Орлов', overrunProb: 0.4 }],
    });
    expect(tense.band).toBe('yellow');
    expect(tense.lines[0]?.before).toContain('уже включено');
    expect(tense.lines[0]?.before).not.toContain('забирает такой остаток');
    expect(tense.lines[1]?.shortId).toBe('ac0446e1');
    expect(tense.lines[1]?.requestId).toBe('ac0446e1-1');
    expect(tense.lines[2]?.before).toContain('Михаил Орлов');
  });

  it('does not invent a rehearsal when the plan has no visits', () => {
    const empty = unroutedPlanAdvice({ unassignedCount: 14, rosterOffline: true });
    expect(empty.band).toBe('red');
    expect(empty.title).toBe('Высокий риск');
    expect(empty.summary).toContain('не из чего проверять');
    expect(empty.lines[1]?.before).toContain('не вышли на линию');
  });
});

describe('policy recommendation', () => {
  it('prefers coverage, then does not switch off a policy that already wins', () => {
    const uncovered = recommendPolicy({
      active: 'balanced',
      unassignedCount: 3,
      robustness: 0.8,
      rosterOffline: false,
      maxBreach: 0,
      maxOverrun: 0,
    });
    expect(uncovered.policyId).toBe('covering');
    expect(uncovered.sameAsActive).toBe(false);

    const quiet = recommendPolicy({
      active: 'balanced',
      unassignedCount: 0,
      robustness: 0.95,
      rosterOffline: false,
      maxBreach: 0,
      maxOverrun: 0,
    });
    expect(quiet.sameAsActive).toBe(true);

    const offline = recommendPolicy({
      active: 'covering',
      unassignedCount: 14,
      robustness: null,
      rosterOffline: true,
      maxBreach: 0,
      maxOverrun: 0,
    });
    expect(offline.reason).toContain('на линии');
  });

  it('picks the comparison row that covers more requests', () => {
    const row = (
      id: 'balanced' | 'covering',
      assigned: number,
      unassigned: number,
    ) => ({
      strategyId: id,
      kind: 'policy' as const,
      isUsable: true,
      calculationMs: 10,
      metrics: {
        requestsTotal: assigned + unassigned,
        assignedCount: assigned,
        unassignedCount: unassigned,
        urgentTotal: 0,
        urgentAssignedCount: 0,
        engineersUsed: 3,
        distanceKm: 40,
        travelTimeSec: 3000,
        workTimeSec: 0,
        waitingTimeSec: 0,
        lunchTimeSec: 0,
        lateAssignedCount: 0,
        totalLatenessSec: 0,
        minWindowSlackSec: 600,
        workloadSpreadSec: 100,
        maxWorkloadSec: 1000,
      },
    });
    const picked = recommendPolicy({
      active: 'balanced',
      unassignedCount: 1,
      robustness: 0.8,
      rosterOffline: false,
      maxBreach: 0.1,
      maxOverrun: 0,
      rows: [row('balanced', 13, 1), row('covering', 14, 0)],
    });
    expect(picked.policyId).toBe('covering');
  });
});
