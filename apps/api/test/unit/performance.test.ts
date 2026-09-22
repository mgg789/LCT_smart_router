import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedClock } from '../../src/common/time';
import {
  isSelectionInDay,
  PerformanceService,
} from '../../src/orchestrator/performance/performance.service';
import {
  combineScore,
  interventionQuality,
  scoreAlertProcessing,
  scorePolicyChoice,
} from '../../src/orchestrator/performance/scoring';
import type {
  AlertAttribution,
  PerformanceDaySnapshot,
  PolicyComparisonEvidence,
} from '../../src/orchestrator/performance/types';
import type { PrismaService } from '../../src/persistence';

test('engineer day response excludes other engineers and dispatcher evidence', async () => {
  const own = {
    engineerId: 'own',
    completed: 1,
    cancelled: 0,
    assumedCompleted: 0,
    workMinutes: 40,
  };
  const snapshot: PerformanceDaySnapshot = {
    version: 1,
    workdayId: 'day',
    workDate: '2026-09-22',
    capturedAt: 1,
    closedAt: 1,
    engineerCount: 2,
    actual: { completed: 2, cancelled: 0, assumedCompleted: 0 },
    workMinutes: 80,
    engineers: [own, { ...own, engineerId: 'other' }],
    alerts: { significantTotal: 0, resolved: 0, unresolved: 0, groups: [] },
    policy: {
      selectedPolicyId: null,
      evidence: null,
      measured: false,
      score: 100,
      explanation: 'none',
    },
    score: combineScore(scoreAlertProcessing([], new Set()), scorePolicyChoice(null, null)),
  };
  class SnapshotService extends PerformanceService {
    override async day(): Promise<PerformanceDaySnapshot> {
      return snapshot;
    }
  }
  const service = new SnapshotService({} as PrismaService, new FixedClock(1));
  assert.deepEqual(await service.engineerDay('day', 'own'), {
    workdayId: 'day',
    workDate: '2026-09-22',
    closedAt: 1,
    engineer: own,
  });
});

function attribution(
  actorSource: 'ui' | 'ai_run',
  createdAt = 1_000,
  actionAt = createdAt,
): AlertAttribution {
  return {
    version: 1,
    alertId: 'alert-1',
    code: 'time_risk',
    workDate: '2026-09-22',
    createdAt,
    firstAction: { action: 'keep_as_is', at: actionAt, actorKind: 'account', actorSource },
    outcome: 'resolved',
    resolvedAt: createdAt + 1,
    resolutionReason: null,
  };
}

test('alert quality uses the accepted fastest/timely/slow ordinal boundaries', () => {
  assert.equal(interventionQuality(attribution('ui', 1_000, 1_120)).score, 100);
  assert.equal(interventionQuality(attribution('ui', 1_000, 1_121)).score, 90);
  assert.equal(interventionQuality(attribution('ui', 1_000, 1_600)).score, 90);
  assert.equal(interventionQuality(attribution('ui', 1_000, 1_601)).score, 65);
  assert.equal(interventionQuality(attribution('ai_run', 1_000, 1_120)).score, 55);
  assert.equal(interventionQuality(attribution('ai_run', 1_000, 1_600)).score, 80);
  assert.equal(interventionQuality(attribution('ai_run', 1_000, 1_601)).score, 40);
});

test('end-day quality is ten only after 17:00 Moscow and over ten minutes', () => {
  const beforeEnd = Math.floor(Date.parse('2026-09-22T16:59:00+03:00') / 1000);
  const afterEnd = Math.floor(Date.parse('2026-09-22T17:01:00+03:00') / 1000);
  assert.equal(interventionQuality(attribution('ui', beforeEnd - 601, beforeEnd)).score, 65);
  assert.equal(interventionQuality(attribution('ui', afterEnd - 601, afterEnd)).score, 10);
});

test('missing evidence is explicitly not evaluated and contributes a neutral full part', () => {
  const alerts = scoreAlertProcessing([], new Set());
  const policy = scorePolicyChoice(null, null);
  const score = combineScore(alerts, policy);
  assert.equal(alerts.evaluated, false);
  assert.equal(policy.evaluated, false);
  assert.equal(score.score, 100);
  assert.equal(score.evaluated, false);
});

test('a significant alert without attribution remains in the zero-scored denominator', () => {
  const score = scoreAlertProcessing([], new Set(['unattributed-alert']));
  assert.equal(score.evaluated, true);
  assert.equal(score.score, 0);
});

test('policy score follows urgent coverage, then total coverage before SLA and travel', () => {
  const metrics = (urgentAssignedCount: number, assignedCount: number, travelTimeSec: number) => ({
    requestsTotal: 2,
    assignedCount,
    unassignedCount: 2 - assignedCount,
    urgentTotal: 1,
    urgentAssignedCount,
    engineersUsed: 1,
    distanceKm: travelTimeSec / 100,
    travelTimeSec,
    workTimeSec: 1_000,
    waitingTimeSec: 0,
    lunchTimeSec: 0,
    lateAssignedCount: 0,
    totalLatenessSec: 0,
    minWindowSlackSec: 100,
    workloadSpreadSec: 0,
    maxWorkloadSec: 1_000,
  });
  const evidence: PolicyComparisonEvidence = {
    version: 1,
    inputPublicationId: 'publication',
    inputHash: 'input',
    routerContextVersion: 'router',
    rosterHash: 'roster',
    rosterEngineerIds: ['engineer'],
    computedAt: 1,
    searchBudgetMs: 100,
    savedAt: 1,
    rows: [
      {
        strategyId: 'fast',
        kind: 'policy',
        additionalEngineers: 0,
        isUsable: true,
        calculationMs: 1,
        metrics: metrics(0, 2, 10),
      },
      {
        strategyId: 'sla',
        kind: 'policy',
        additionalEngineers: 0,
        isUsable: true,
        calculationMs: 1,
        metrics: metrics(1, 1, 100),
      },
      {
        strategyId: 'covering',
        kind: 'policy',
        additionalEngineers: 1,
        isUsable: true,
        calculationMs: 1,
        metrics: metrics(1, 2, 1),
      },
    ],
  };
  assert.equal(scorePolicyChoice(evidence, 'sla').score, 100);
  assert.equal(scorePolicyChoice(evidence, 'fast').score, 0);
});

test('policy ties receive the same ordinal score and prior-day choices are excluded', () => {
  const metrics = (travelTimeSec: number) => ({
    requestsTotal: 1,
    assignedCount: 1,
    unassignedCount: 0,
    urgentTotal: 0,
    urgentAssignedCount: 0,
    engineersUsed: 1,
    distanceKm: travelTimeSec / 100,
    travelTimeSec,
    workTimeSec: 1_000,
    waitingTimeSec: 0,
    lunchTimeSec: 0,
    lateAssignedCount: 0,
    totalLatenessSec: 0,
    minWindowSlackSec: 100,
    workloadSpreadSec: 0,
    maxWorkloadSec: 1_000,
  });
  const evidence: PolicyComparisonEvidence = {
    version: 1,
    inputPublicationId: 'publication',
    inputHash: 'input',
    routerContextVersion: 'router',
    rosterHash: 'roster',
    rosterEngineerIds: ['engineer'],
    computedAt: 1,
    searchBudgetMs: 100,
    savedAt: 1,
    rows: [
      {
        strategyId: 'best-a',
        kind: 'policy',
        additionalEngineers: 0,
        isUsable: true,
        calculationMs: 1,
        metrics: metrics(1),
      },
      {
        strategyId: 'best-b',
        kind: 'policy',
        additionalEngineers: 0,
        isUsable: true,
        calculationMs: 1,
        metrics: metrics(1),
      },
      {
        strategyId: 'slow',
        kind: 'policy',
        additionalEngineers: 0,
        isUsable: true,
        calculationMs: 1,
        metrics: metrics(2),
      },
    ],
  };
  assert.equal(scorePolicyChoice(evidence, 'best-a').score, 100);
  assert.equal(scorePolicyChoice(evidence, 'best-b').score, 100);
  assert.equal(scorePolicyChoice(evidence, 'slow').score, 0);
  assert.equal(isSelectionInDay(99, 100, 200), false);
  assert.equal(isSelectionInDay(100, 100, 200), true);
  assert.equal(isSelectionInDay(201, 100, 200), false);
});
