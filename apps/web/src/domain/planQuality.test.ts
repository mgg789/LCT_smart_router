import { describe, expect, it } from 'vitest';
import { planQualityAdvice, qualityBand, unroutedPlanAdvice } from './planQuality';
import { recommendPolicy } from './policyRecommend';

describe('plan quality advice', () => {
  it('bands on the expected late count and share, never on zero-late days', () => {
    expect(qualityBand({ expectedLate: 0.4, expectedLateShare: 0.01, visitsTotal: 50 })).toBe('green');
    expect(qualityBand({ expectedLate: 2, expectedLateShare: 0.04, visitsTotal: 50 })).toBe('yellow');
    expect(qualityBand({ expectedLate: 3, expectedLateShare: 0.11, visitsTotal: 50 })).toBe('yellow');
    expect(qualityBand({ expectedLate: 4, expectedLateShare: 0.2, visitsTotal: 50 })).toBe('red');
    // A plan can be structurally late even when some days pass cleanly.
    expect(qualityBand({ expectedLate: 8, expectedLateShare: 0.16, visitsTotal: 50 })).toBe('red');
  });

  it('uses the dispatcher titles and the honest late count', () => {
    const plan = (expectedLate: number, expectedLateShare: number) => ({
      expectedLate,
      expectedLateShare,
      visitsTotal: 50,
    });
    expect(
      planQualityAdvice({
        plan: plan(0.2, 0.004),
        unassignedCount: 0,
        activePolicy: 'balanced',
        requests: [],
        engineers: [],
      }).title,
    ).toBe('План надёжный');
    expect(
      planQualityAdvice({
        plan: plan(2, 0.04),
        unassignedCount: 0,
        activePolicy: 'balanced',
        requests: [],
        engineers: [],
      }).title,
    ).toBe('Можно работать');
    const red = planQualityAdvice({
      plan: plan(8.4, 0.16),
      unassignedCount: 0,
      activePolicy: 'balanced',
      requests: [],
      engineers: [],
    });
    expect(red.title).toBe('Высокий риск');
    expect(red.summary).toContain('~8');
    expect(red.summary).toContain('50');
  });

  it('does not suggest the policy that is already on, and links the risky request', () => {
    const tense = planQualityAdvice({
      plan: { expectedLate: 2, expectedLateShare: 0.04, visitsTotal: 50 },
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
