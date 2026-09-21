import type { PolicyId } from './types';

/** A policy row, or the FIFO baseline the case statement compares against. */
export type StrategyId = PolicyId | 'baseline';

export interface ComparisonMetrics {
  requestsTotal: number;
  assignedCount: number;
  unassignedCount: number;
  urgentTotal: number;
  urgentAssignedCount: number;
  engineersUsed: number;
  distanceKm: number;
  travelTimeSec: number;
  workTimeSec: number;
  waitingTimeSec: number;
  lunchTimeSec: number;
  lateAssignedCount: number;
  totalLatenessSec: number;
  /** `null` when nothing was assigned, so there is no window to keep slack in. */
  minWindowSlackSec: number | null;
  workloadSpreadSec: number;
  maxWorkloadSec: number;
}

export interface ComparisonRow {
  strategyId: StrategyId;
  kind: 'policy' | 'baseline';
  /** Crews the covering strategy added on top of the day's roster. */
  additionalEngineers?: number;
  /** `false` is not proof the visits are impossible — only that this plan is not usable. */
  isUsable: boolean;
  calculationMs: number;
  metrics: ComparisonMetrics;
}

/** `GET /dispatch/policy-comparison` — every strategy on the same published input. */
export interface PolicyComparison {
  inputPublicationId: string;
  inputHash: string;
  routerContextVersion: string;
  /** Unix seconds. */
  computedAt: number;
  searchBudgetMs: number;
  rows: ComparisonRow[];
}
