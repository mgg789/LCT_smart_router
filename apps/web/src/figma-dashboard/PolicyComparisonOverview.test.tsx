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
  waitingTimeSec = 0,
  totalLatenessSec = 0,
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
      waitingTimeSec,
      lunchTimeSec: 0,
      lateAssignedCount: 0,
      totalLatenessSec,
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
    expect(html).toContain('назначено 10 заявок против 5 у FIFO');
    expect(html).toContain('-20%');
    expect(html).toContain('резервных инженеров');
    expect(html).toContain('Показатель расходов');
    expect(html).toContain('aria-label="Доля опозданий"');
    expect(html).toContain('Ожидание на заявку');
    expect(html).toContain('Задержка на заявку');
    expect(html).not.toContain('value="lateShare"');
    expect(html).toContain('aria-label="Задействованные инженеры"');
    expect(comparisonValue(row('fast', 10, 80), 'engineers')).toBe(3);
    expect(comparisonValue(row('fast', 10, 80, 0, 120), 'waitingPerJob')).toBe(0.2);
    expect(comparisonValue(row('fast', 10, 80, 0, 0, 600), 'latenessPerJob')).toBe(1);
    expect(comparisonValue(row('fast', 0, 0), 'waitingPerJob')).toBeNull();
    expect(comparisonValue(row('fast', 0, 0), 'latenessPerJob')).toBeNull();
    expect(html).not.toContain('20 из 20');
  });

  it('draws the completion chart across the card at the taller smoothed size', () => {
    const start = 1_700_000_000;
    const html = renderToStaticMarkup(
      <PolicyComparisonOverview
        rows={[
          { ...row('baseline', 2, 10), jobEnds: [start, start + 3600] },
          { ...row('fast', 3, 12), jobEnds: [start + 600, start + 1800, start + 4000] },
        ]}
      />,
    );
    expect(html).toContain('h-[450px]');
    expect(html).toContain('w-full');
    expect(html).toContain('<polyline');
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it('renders zero-work data without fabricated percentages or invalid bar lengths', () => {
    const html = renderToStaticMarkup(
      <PolicyComparisonOverview rows={[row('baseline', 0, 0), row('fast', 0, 0)]} />,
    );
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).toContain('нет сопоставимой оценки');
  });
});
