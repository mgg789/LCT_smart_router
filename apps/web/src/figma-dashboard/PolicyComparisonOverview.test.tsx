import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PolicyComparisonRow } from '../api/types';
import { comparisonValue, comparisonWinners } from '../lib/policyComparison';
import { PolicyComparisonOverview } from './PolicyComparisonOverview';

function row(
  strategyId: PolicyComparisonRow['strategyId'],
  assignedCount: number,
  distanceKm: number,
  additionalEngineers = 0,
): PolicyComparisonRow {
  return {
    strategyId,
    kind: strategyId === 'baseline' ? 'baseline' : 'policy',
    isUsable: true,
    calculationMs: 1,
    additionalEngineers,
    metrics: {
      requestsTotal: 20,
      assignedCount,
      unassignedCount: 20 - assignedCount,
      urgentTotal: 0,
      urgentAssignedCount: 0,
      engineersUsed: 3 + additionalEngineers,
      distanceKm,
      travelTimeSec: distanceKm * 60,
      workTimeSec: assignedCount * 600,
      waitingTimeSec: 0,
      lunchTimeSec: 0,
      lateAssignedCount: 0,
      totalLatenessSec: 0,
      minWindowSlackSec: null,
      workloadSpreadSec: 0,
      maxWorkloadSec: 0,
    },
  };
}

describe('honest policy comparisons', () => {
  it('compares travel per assigned job when higher coverage uses more total kilometres', () => {
    const fifo = row('baseline', 5, 50);
    const fast = row('fast', 10, 80);
    expect(fast.metrics.distanceKm).toBeGreaterThan(fifo.metrics.distanceKm);
    expect(comparisonValue(fast, 'kmPerJob')).toBe(8);
    expect(comparisonValue(fifo, 'kmPerJob')).toBe(10);
    expect([
      ...comparisonWinners([fifo, fast], (item) => comparisonValue(item, 'kmPerJob'), 'min'),
    ]).toEqual(['fast']);
  });

  it('never ranks an empty or unusable plan as the cheapest assignment', () => {
    const empty = row('eco', 0, 0);
    const invalid = { ...row('fast', 10, 1), isUsable: false };
    const fifo = row('baseline', 5, 50);
    expect(comparisonValue(empty, 'kmPerJob')).toBeNull();
    expect([
      ...comparisonWinners(
        [empty, invalid, fifo],
        (item) => comparisonValue(item, 'kmPerJob'),
        'min',
      ),
    ]).toEqual([]);
  });

  it('keeps reserve capacity outside fixed-roster winners and leaves ties neutral', () => {
    const fifo = row('baseline', 5, 50);
    const fast = row('fast', 10, 80);
    const reserve = row('covering', 20, 10, 8);
    expect([
      ...comparisonWinners(
        [fifo, fast, reserve],
        (item) => comparisonValue(item, 'assigned'),
        'max',
      ),
    ]).toEqual(['fast']);
    expect([
      ...comparisonWinners(
        [fast, row('eco', 10, 80)],
        (item) => comparisonValue(item, 'kmPerJob'),
        'min',
      ),
    ]).toEqual([]);
  });

  it('renders visible FIFO deltas, units and an explicit optional reserve comparison', () => {
    const html = renderToStaticMarkup(
      <PolicyComparisonOverview
        rows={[row('baseline', 5, 50), row('fast', 10, 80), row('covering', 20, 10, 8)]}
      />,
    );
    expect(html).toContain('10 из 20');
    expect(html).toContain('+5 к FIFO');
    expect(html).toContain('-20%');
    expect(html).toContain('резервных инженеров');
    expect(html).toContain('Показатель расходов');
    expect(html).toContain('Меньше опозданий');
    expect(html).toContain('Меньше инженеров');
    expect(html).not.toContain('20 из 20');
  });

  it('renders zero-work data without fabricated percentages or invalid bar lengths', () => {
    const html = renderToStaticMarkup(
      <PolicyComparisonOverview rows={[row('baseline', 0, 0), row('fast', 0, 0)]} />,
    );
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain('нет сопоставимой оценки');
  });
});
