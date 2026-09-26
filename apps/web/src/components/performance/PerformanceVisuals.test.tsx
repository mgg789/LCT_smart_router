import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { engineerAnalyticsSchema, monthlyPerformanceSchema } from '../../api/performance';
import { MonthlyReportContent } from './MonthlyResults';
import { EngineerMetricGrid, metricNumber, teamDifference } from './PerformanceVisuals';

const analytics = {
  recordedWorkdays: 2,
  completed: 6,
  completedPerRecordedWorkday: 3,
  measuredDuration: { averageMinutes: 45, sampleCount: 4 },
  punctualCompletion: {
    count: 3,
    sampleCount: 4,
    rate: 0.75,
    averageLatenessMinutes: 5,
    baseline: 'accepted_finish_at' as const,
  },
  utilization: {
    recordedWorkMinutes: 180,
    scheduledMinutes: 960,
    rate: 0.1875,
    coverage: 'partial_confirmed_execution' as const,
  },
};

describe('factual performance presentation', () => {
  it('keeps missing evidence distinct from measured zero and zero benchmarks finite', () => {
    expect(metricNumber(null, ' мин')).toBe('—');
    expect(metricNumber(0, ' мин')).toBe('0 мин');
    expect(teamDifference(3, 0)).toBe('+3 к среднему команды');
    expect(teamDifference(null, 0)).toContain('Недостаточно данных');
  });
  it('exposes timing denominators and partial utilization, not a generic personnel score', () => {
    const html = renderToStaticMarkup(
      <EngineerMetricGrid analytics={engineerAnalyticsSchema.parse(analytics)} />,
    );
    expect(html).toContain('75%');
    expect(html).toContain('3 из 4 с сохранённым сроком');
    expect(html).toContain('4 пар отметок');
    expect(html).toContain('дорога и работа без отметок сюда не входят');
  });
  it('reads a legacy frozen report without inventing new measurements', () => {
    const report = monthlyPerformanceSchema.parse({
      version: 1,
      month: '2026-08',
      generatedAt: 1,
      provisional: false,
      coverageStartAt: null,
      totals: {
        completed: 0,
        cancelled: 0,
        assumedCompleted: 0,
        workMinutes: 0,
        engineerCount: 0,
        earnedPoints: 0,
        penaltyPoints: 0,
        teamAverage: null,
      },
      engineers: [],
      days: [],
      notes: [],
    });
    const html = renderToStaticMarkup(<MonthlyReportContent report={report} />);
    expect(report.analytics).toBeUndefined();
    expect(html).toContain('нет подробных измерений');
    expect(html).toContain('пока нет данных для графика');
    expect(html).not.toContain('NaN');
  });
  it('keeps closed zero days when a partial new series is present', () => {
    const report = monthlyPerformanceSchema.parse({
      version: 1,
      month: '2026-09',
      generatedAt: 1,
      provisional: true,
      coverageStartAt: null,
      totals: {
        completed: 2,
        cancelled: 0,
        assumedCompleted: 0,
        workMinutes: 0,
        engineerCount: 0,
        earnedPoints: 0,
        penaltyPoints: 0,
        teamAverage: null,
      },
      engineers: [],
      notes: [],
      days: [
        {
          workDate: '2026-09-01',
          score: 0,
          evaluated: false,
          completed: 0,
          alertsResolved: 0,
          alertsTotal: 0,
        },
      ],
      analytics: {
        team: analytics,
        engineers: [],
        dailySeries: [{ workDate: '2026-09-02', completed: 2 }],
      },
    });
    const html = renderToStaticMarkup(<MonthlyReportContent report={report} />);
    expect(html).toContain('2026-09-01: 0 выполнено');
    expect(html).toContain('2026-09-02: 2 выполнено');
  });
});
