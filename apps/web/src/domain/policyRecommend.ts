import type { PolicyComparisonRow, PolicyId } from '../api/types';
import { t } from '../i18n';
import { POLICY_LABELS } from '../lib/reasons';

/**
 * Which prepared policy to suggest, and why, in dispatcher language.
 *
 * The score is a fixed weighted sum over the already computed comparison,
 * not a fitted model: coverage dominates, then spare time in the window,
 * then a shorter drive. Symptom rules cover the moment before that table exists.
 */

export interface PolicyRecommendation {
  readonly policyId: PolicyId;
  readonly label: string;
  readonly reason: string;
  readonly sameAsActive: boolean;
}

export function recommendPolicy(input: {
  readonly active: PolicyId;
  readonly unassignedCount: number;
  readonly robustness: number | null;
  readonly rosterOffline: boolean;
  readonly maxBreach: number;
  readonly maxOverrun: number;
  readonly rows?: readonly PolicyComparisonRow[];
}): PolicyRecommendation {
  const fromTable = input.rows ? bestComparedPolicy(input.rows) : null;
  if (fromTable) {
    return describe(input.active, fromTable, input);
  }
  return describe(input.active, symptomPolicy(input), input);
}

function bestComparedPolicy(rows: readonly PolicyComparisonRow[]): PolicyId | null {
  const usable = rows.filter((row) => row.kind === 'policy' && row.isUsable);
  if (usable.length === 0) return null;
  const ranked = [...usable].sort((left, right) => scoreRow(right) - scoreRow(left));
  const winner = ranked[0];
  return winner ? (winner.strategyId as PolicyId) : null;
}

/** Higher is better. Uncovered requests outweigh a shorter drive. */
function scoreRow(row: PolicyComparisonRow): number {
  const metrics = row.metrics;
  const slack = metrics.minWindowSlackSec ?? 0;
  return (
    metrics.assignedCount * 1_000 -
    metrics.unassignedCount * 5_000 +
    slack / 60 -
    metrics.travelTimeSec / 120 -
    metrics.distanceKm -
    metrics.workloadSpreadSec / 600
  );
}

function symptomPolicy(input: {
  readonly active: PolicyId;
  readonly unassignedCount: number;
  readonly robustness: number | null;
  readonly rosterOffline: boolean;
  readonly maxBreach: number;
  readonly maxOverrun: number;
}): PolicyId {
  if (input.rosterOffline) return input.active;
  if (input.unassignedCount > 0 && input.active !== 'covering') return 'covering';
  if (input.maxBreach >= 0.2 && input.active !== 'fast' && input.active !== 'sla') return 'fast';
  if (input.maxBreach >= 0.2 && input.active === 'fast') return 'sla';
  if (input.maxOverrun >= 0.3 && input.active !== 'balanced') return 'balanced';
  return input.active;
}

function describe(
  active: PolicyId,
  suggested: PolicyId,
  input: {
    readonly unassignedCount: number;
    readonly rosterOffline: boolean;
    readonly maxBreach: number;
    readonly maxOverrun: number;
  },
): PolicyRecommendation {
  const sameAsActive = suggested === active;
  const label = POLICY_LABELS[suggested] ?? suggested;
  if (input.rosterOffline) {
    return {
      policyId: active,
      label: POLICY_LABELS[active] ?? active,
      sameAsActive: true,
      reason: t('domain.policyRecommend.028e5e8b70'),
    };
  }
  if (sameAsActive && input.unassignedCount > 0 && active === 'covering') {
    return {
      policyId: suggested,
      label,
      sameAsActive: true,
      reason: t('domain.policyRecommend.aa764329c6'),
    };
  }
  if (sameAsActive) {
    return {
      policyId: suggested,
      label,
      sameAsActive: true,
      reason: t('domain.policyRecommend.87ebbe7c10'),
    };
  }
  const reason =
    suggested === 'covering'
      ? t('domain.policyRecommend.ba86e9b723')
      : suggested === 'fast'
        ? t('domain.policyRecommend.c1eff03628')
        : suggested === 'sla'
          ? t('domain.policyRecommend.bf4dd5bdee')
          : suggested === 'balanced'
            ? t('domain.policyRecommend.a3ef25f6c5')
            : suggested === 'eco'
              ? t('domain.policyRecommend.30e0a36854')
              : t('domain.policyRecommend.66180192bd');
  return { policyId: suggested, label, sameAsActive: false, reason };
}
