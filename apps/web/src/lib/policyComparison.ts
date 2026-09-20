import type { StrategyId } from '../api/types';
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
export function percentVsFifo(value: number | null, baseline: number | null | undefined): string | null {
  if (value === null || baseline === null || baseline === undefined || baseline === 0) {
    return null;
  }
  const percent = Math.round(((value - baseline) / baseline) * 100);
  return `${percent > 0 ? '+' : ''}${percent}%`;
}
