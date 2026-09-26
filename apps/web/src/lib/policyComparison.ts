import type { PolicyComparisonRow, StrategyId } from '../api/types';
import { POLICY_DESCRIPTIONS, POLICY_LABELS } from './reasons';
import { formatDurationMin } from './time';

/** Dispatcher label for a comparison row, including the official FIFO baseline. */
export function strategyLabel(strategyId: StrategyId): string {
  return strategyId === 'baseline' ? 'Базовая из ТЗ' : (POLICY_LABELS[strategyId] ?? strategyId);
}

/** Short strategy blurb shown under the comparison name. */
export function strategyDescription(strategyId: StrategyId): string {
  return POLICY_DESCRIPTIONS[strategyId] ?? strategyId;
}

/** Distance per assigned request, or a dash when nothing was assigned. */
export function perAssignmentKm(distanceKm: number, assignedCount: number): string {
  return assignedCount > 0
    ? `${(distanceKm / assignedCount).toFixed(1).replace('.', ',')} км/назначение`
    : '— км/назначение';
}

/** Travel time per assigned request. */
export function perAssignmentDuration(durationSec: number, assignedCount: number): string {
  return assignedCount > 0
    ? `${formatDurationMin(durationSec / assignedCount)}/назначение`
    : '— мин/назначение';
}

/** Percent change versus the FIFO baseline; null when the baseline is missing or zero. */
export function percentVsFifo(
  value: number | null,
  baseline: number | null | undefined,
): string | null {
  if (value === null || baseline === null || baseline === undefined || baseline === 0) {
    return null;
  }
  const percent = Math.round(((value - baseline) / baseline) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

/** Values suitable for comparing strategies with unequal assigned-job counts. */
export type ComparisonMeasure =
  | 'assigned'
  | 'onTime'
  | 'engineers'
  | 'kmPerJob'
  | 'travelPerJob'
  | 'lateShare';

/** Normalize costs by assigned work; an empty plan has no per-job efficiency. */
export function comparisonValue(
  row: PolicyComparisonRow,
  measure: ComparisonMeasure,
): number | null {
  const metrics = row.metrics;
  if (measure === 'assigned') return metrics.assignedCount;
  if (measure === 'onTime') return metrics.assignedCount - metrics.lateAssignedCount;
  if (measure === 'engineers') return metrics.engineersUsed;
  if (metrics.assignedCount === 0) return null;
  if (measure === 'kmPerJob') return metrics.distanceKm / metrics.assignedCount;
  if (measure === 'travelPerJob') return metrics.travelTimeSec / metrics.assignedCount / 60;
  return (metrics.lateAssignedCount / metrics.assignedCount) * 100;
}

/** Reserve capacity is shown explicitly and never wins a fixed-roster comparison. */
export function usesReserve(row: PolicyComparisonRow): boolean {
  return (row.additionalEngineers ?? 0) > 0;
}

/** Joint winners among usable fixed-roster rows; equal columns convey no advantage. */
export function comparisonWinners(
  rows: readonly PolicyComparisonRow[],
  readValue: (row: PolicyComparisonRow) => number | null,
  better: 'min' | 'max' | null,
): ReadonlySet<string> {
  if (better === null) return new Set();
  const values = rows
    .filter((row) => row.isUsable && !usesReserve(row))
    .map((row) => ({ id: row.strategyId, value: readValue(row) }))
    .filter(
      (row): row is { id: StrategyId; value: number } =>
        row.value !== null && Number.isFinite(row.value),
    );
  if (values.length < 2 || values.every((row) => row.value === values[0]?.value)) return new Set();
  const target =
    better === 'min'
      ? Math.min(...values.map((row) => row.value))
      : Math.max(...values.map((row) => row.value));
  return new Set(values.filter((row) => row.value === target).map((row) => row.id));
}
