import type { ActorKind, ActorSource } from '../../generated/prisma/client';

/** One authenticated intervention attributed to a significant alert. */
export interface AlertAttribution {
  readonly version: 1;
  readonly alertId: string;
  readonly code: string;
  readonly workDate: string | null;
  readonly createdAt: number;
  readonly firstAction: {
    readonly action: string;
    readonly at: number;
    readonly actorKind: ActorKind;
    readonly actorSource: ActorSource;
  } | null;
  /** `pending` is used for a window move until a later accepted plan resolves it. */
  readonly outcome: 'pending' | 'resolved';
  readonly resolvedAt: number | null;
  readonly resolutionReason: string | null;
}

/** Metrics returned by Router for one exact policy-comparison input. */
export interface PolicyMetrics {
  readonly requestsTotal: number;
  readonly assignedCount: number;
  readonly unassignedCount: number;
  readonly urgentTotal: number;
  readonly urgentAssignedCount: number;
  readonly engineersUsed: number;
  readonly distanceKm: number;
  readonly travelTimeSec: number;
  readonly workTimeSec: number;
  readonly waitingTimeSec: number;
  readonly lunchTimeSec: number;
  readonly lateAssignedCount: number;
  readonly totalLatenessSec: number;
  readonly minWindowSlackSec: number | null;
  readonly workloadSpreadSec: number;
  readonly maxWorkloadSec: number;
}

/** Immutable comparison evidence saved after the dispatcher reads a comparison. */
export interface PolicyComparisonEvidence {
  readonly version: 1;
  readonly inputPublicationId: string;
  readonly inputHash: string;
  readonly routerContextVersion: string;
  readonly rosterHash: string;
  readonly rosterEngineerIds: readonly string[];
  readonly computedAt: number;
  readonly searchBudgetMs: number;
  readonly rows: readonly PolicyComparisonRow[];
  readonly savedAt: number;
}

export interface PolicyComparisonRow {
  readonly strategyId: string;
  readonly kind: 'policy' | 'baseline';
  readonly additionalEngineers: number;
  readonly isUsable: boolean;
  readonly calculationMs: number;
  readonly metrics: PolicyMetrics;
}

/** A policy choice persisted by an authenticated operation. */
export interface PolicySelection {
  readonly version: 1;
  readonly policyId: string;
  readonly operationId: string;
  readonly actorKind: ActorKind;
  readonly actorSource: ActorSource;
  readonly selectedAt: number;
  readonly evidenceKey: string | null;
  readonly inputHash: string | null;
  readonly routerContextVersion: string | null;
  readonly rosterHash: string | null;
}

export interface AlertGroupMetric {
  readonly code: string;
  readonly total: number;
  readonly resolved: number;
  readonly unresolved: number;
}

export interface EngineerPerformanceMetric {
  readonly engineerId: string;
  readonly completed: number;
  readonly cancelled: number;
  readonly assumedCompleted: number;
  readonly workMinutes: number;
}

/**
 * Confirmed execution and shift-coverage metrics for one engineer or an aggregate team.
 * Every nullable measurement has no sufficient durable source fact; it is never inferred.
 */
export interface EngineerAnalytics {
  readonly engineerId: string | null;
  readonly name: string | null;
  readonly recordedWorkdays: number;
  readonly completed: number;
  readonly completedPerRecordedWorkday: number | null;
  readonly measuredDuration: {
    readonly averageMinutes: number | null;
    readonly sampleCount: number;
  };
  readonly punctualCompletion: {
    readonly count: number;
    readonly sampleCount: number;
    readonly rate: number | null;
    readonly averageLatenessMinutes: number | null;
    readonly baseline: 'accepted_finish_at';
  };
  readonly utilization: {
    readonly recordedWorkMinutes: number;
    readonly scheduledMinutes: number;
    readonly rate: number | null;
    readonly coverage: 'partial_confirmed_execution';
  };
}

/** Additive factual analytics; base performance counters remain available for compatibility. */
export interface PerformanceAnalytics {
  readonly team: EngineerAnalytics;
  readonly engineers: readonly EngineerAnalytics[];
}

export interface NextDayRequestPreview {
  readonly requestId: string;
  readonly arrivalOrder: number;
  readonly addressText: string;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly priority: string;
}

export interface ScoreComponent {
  readonly score: number;
  readonly weight: number;
  readonly evaluated: boolean;
  readonly explanation: string;
}

export interface DispatcherPerformanceScore {
  readonly score: number;
  readonly evaluated: boolean;
  readonly alertProcessing: ScoreComponent;
  readonly policyChoice: ScoreComponent;
  readonly explanation: readonly string[];
}

export interface PerformanceDaySnapshot {
  readonly version: 1;
  readonly workdayId: string;
  readonly workDate: string;
  readonly capturedAt: number;
  readonly closedAt: number | null;
  readonly engineerCount: number;
  readonly actual: {
    readonly completed: number;
    readonly cancelled: number;
    readonly assumedCompleted: number;
  };
  readonly workMinutes: number;
  readonly engineers: readonly EngineerPerformanceMetric[];
  readonly analytics?: PerformanceAnalytics;
  readonly nextDay?: {
    readonly workDate: string;
    readonly openRequestCount: number;
    readonly overdueOpenCount: number;
    readonly requests: readonly NextDayRequestPreview[];
  } | null;
  readonly alerts: {
    readonly significantTotal: number;
    readonly resolved: number;
    readonly unresolved: number;
    readonly groups: readonly AlertGroupMetric[];
  };
  readonly policy: {
    readonly selectedPolicyId: string | null;
    readonly evidence: PolicyComparisonEvidence | null;
    readonly measured: boolean;
    readonly score: number;
    readonly explanation: string;
  };
  readonly score: DispatcherPerformanceScore;
}

export interface EngineerPerformanceResponse {
  readonly workdayId: string;
  readonly workDate: string;
  readonly closedAt: number | null;
  readonly engineer: EngineerPerformanceMetric | null;
  readonly analytics?: EngineerAnalytics | null;
}
