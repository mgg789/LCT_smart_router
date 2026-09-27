import type { EngineerAnalytics, PerformanceAnalytics } from './types';

export interface AnalyticsDay {
  readonly engineerId: string;
  readonly name: string | null;
  readonly shiftMinutes: number;
}

export interface AnalyticsCompletion {
  readonly requestId: string;
  readonly engineerId: string;
  readonly finishedAt: number;
  readonly durationMinutes: number | null;
  readonly acceptedFinishAt: number | null;
}

interface Totals {
  name: string | null;
  recordedWorkdays: number;
  scheduledMinutes: number;
  completed: number;
  durationMinutes: number;
  durationSamples: number;
  punctual: number;
  punctualSamples: number;
  latenessMinutes: number;
  workMinutes: number;
}

/**
 * Aggregates only explicit finish/start facts and recorded shifts. The caller owns the
 * time scope and must de-duplicate request finishes before passing them here.
 */
export function buildPerformanceAnalytics(
  days: readonly AnalyticsDay[],
  completions: readonly AnalyticsCompletion[],
): PerformanceAnalytics {
  const totals = new Map<string, Totals>();
  const ensure = (engineerId: string, name: string | null = null) => {
    const current = totals.get(engineerId);
    if (current) return current;
    const created: Totals = {
      name,
      recordedWorkdays: 0,
      scheduledMinutes: 0,
      completed: 0,
      durationMinutes: 0,
      durationSamples: 0,
      punctual: 0,
      punctualSamples: 0,
      latenessMinutes: 0,
      workMinutes: 0,
    };
    totals.set(engineerId, created);
    return created;
  };
  for (const day of days) {
    const current = ensure(day.engineerId, day.name);
    current.recordedWorkdays += 1;
    current.scheduledMinutes += Math.max(0, day.shiftMinutes);
  }
  for (const completion of completions) {
    const current = ensure(completion.engineerId);
    current.completed += 1;
    if (completion.durationMinutes !== null) {
      current.durationSamples += 1;
      current.durationMinutes += completion.durationMinutes;
      current.workMinutes += completion.durationMinutes;
    }
    if (completion.acceptedFinishAt !== null) {
      current.punctualSamples += 1;
      const late = Math.max(0, (completion.finishedAt - completion.acceptedFinishAt) / 60);
      current.latenessMinutes += late;
      if (late === 0) current.punctual += 1;
    }
  }
  const rows = [...totals.entries()]
    .map(([engineerId, value]) => toAnalytics(engineerId, value))
    .sort((left, right) =>
      (left.name ?? left.engineerId ?? '').localeCompare(
        right.name ?? right.engineerId ?? '',
        'ru',
      ),
    );
  return { team: aggregateTeam(rows), engineers: rows };
}

function toAnalytics(engineerId: string, totals: Totals): EngineerAnalytics {
  return {
    engineerId,
    name: totals.name,
    recordedWorkdays: totals.recordedWorkdays,
    completed: totals.completed,
    completedPerRecordedWorkday:
      totals.recordedWorkdays === 0 ? null : totals.completed / totals.recordedWorkdays,
    measuredDuration: {
      averageMinutes:
        totals.durationSamples === 0 ? null : totals.durationMinutes / totals.durationSamples,
      sampleCount: totals.durationSamples,
    },
    punctualCompletion: {
      count: totals.punctual,
      sampleCount: totals.punctualSamples,
      rate: totals.punctualSamples === 0 ? null : totals.punctual / totals.punctualSamples,
      averageLatenessMinutes:
        totals.punctualSamples === 0 ? null : totals.latenessMinutes / totals.punctualSamples,
      baseline: 'accepted_finish_at',
    },
    utilization: {
      recordedWorkMinutes: totals.workMinutes,
      scheduledMinutes: totals.scheduledMinutes,
      rate: totals.scheduledMinutes === 0 ? null : totals.workMinutes / totals.scheduledMinutes,
      coverage: 'partial_confirmed_execution',
    },
  };
}

function aggregateTeam(rows: readonly EngineerAnalytics[]): EngineerAnalytics {
  const sums = rows.reduce(
    (result, row) => ({
      workdays: result.workdays + row.recordedWorkdays,
      completed: result.completed + row.completed,
      durationCount: result.durationCount + row.measuredDuration.sampleCount,
      durationTotal:
        result.durationTotal +
        (row.measuredDuration.averageMinutes ?? 0) * row.measuredDuration.sampleCount,
      punctual: result.punctual + row.punctualCompletion.count,
      punctualCount: result.punctualCount + row.punctualCompletion.sampleCount,
      latenessTotal:
        result.latenessTotal +
        (row.punctualCompletion.averageLatenessMinutes ?? 0) * row.punctualCompletion.sampleCount,
      work: result.work + row.utilization.recordedWorkMinutes,
      scheduled: result.scheduled + row.utilization.scheduledMinutes,
    }),
    {
      workdays: 0,
      completed: 0,
      durationCount: 0,
      durationTotal: 0,
      punctual: 0,
      punctualCount: 0,
      latenessTotal: 0,
      work: 0,
      scheduled: 0,
    },
  );
  return {
    engineerId: null,
    name: null,
    recordedWorkdays: sums.workdays,
    completed: sums.completed,
    completedPerRecordedWorkday: sums.workdays === 0 ? null : sums.completed / sums.workdays,
    measuredDuration: {
      averageMinutes: sums.durationCount === 0 ? null : sums.durationTotal / sums.durationCount,
      sampleCount: sums.durationCount,
    },
    punctualCompletion: {
      count: sums.punctual,
      sampleCount: sums.punctualCount,
      rate: sums.punctualCount === 0 ? null : sums.punctual / sums.punctualCount,
      averageLatenessMinutes:
        sums.punctualCount === 0 ? null : sums.latenessTotal / sums.punctualCount,
      baseline: 'accepted_finish_at',
    },
    utilization: {
      recordedWorkMinutes: sums.work,
      scheduledMinutes: sums.scheduled,
      rate: sums.scheduled === 0 ? null : sums.work / sums.scheduled,
      coverage: 'partial_confirmed_execution',
    },
  };
}
