import type { EngineerAnalytics } from '../../api/performance';

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

/** Missing evidence is never formatted as a measured zero. */
export function metricNumber(value: number | null | undefined, suffix = ''): string {
  return value == null || !Number.isFinite(value) ? '—' : `${number.format(value)}${suffix}`;
}

/** A stable benchmark also handles a zero team baseline without infinite percentages. */
export function teamDifference(value: number | null, team: number | null): string {
  if (value === null || team === null) return 'Недостаточно данных для сравнения';
  const delta = value - team;
  if (Math.abs(delta) < 0.05) return 'На уровне среднего команды';
  return `${delta > 0 ? '+' : '−'}${metricNumber(Math.abs(delta))} к среднему команды`;
}

/** Summary tile uses the shared brand palette and keeps the metric definition visible. */
export function ResultMetric({
  value,
  label,
  note,
  tone = 'plain',
}: {
  value: string | number;
  label: string;
  note?: string;
  tone?: 'plain' | 'good' | 'warning' | 'dark';
}) {
  return (
    <div
      className={`min-w-0 rounded-2xl p-5 ${tone === 'dark' ? 'bg-figma-ink text-white' : tone === 'good' ? 'bg-figma-work-bg text-figma-work' : tone === 'warning' ? 'bg-figma-danger/10 text-figma-danger' : 'bg-white text-figma-ink'}`}
    >
      <p className="text-sm font-medium">{label}</p>
      <p
        className={`mt-3 break-words text-3xl font-bold tabular-nums ${tone === 'dark' ? 'text-figma-bee' : ''}`}
      >
        {value}
      </p>
      {note ? <p className="mt-2 text-xs leading-relaxed opacity-80">{note}</p> : null}
    </div>
  );
}

/** A labelled progress bar always exposes the same values as text for nonvisual access. */
export function ResultProgress({
  label,
  value,
  total,
  danger = false,
}: {
  label: string;
  value: number;
  total: number;
  danger?: boolean;
}) {
  const percent = total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <strong className="tabular-nums">
          {value} / {total}
        </strong>
      </div>
      <div className="h-3 overflow-hidden rounded-full bg-figma-track" aria-hidden="true">
        <div
          className={`h-full rounded-full ${danger ? 'bg-figma-danger' : 'bg-figma-work'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Confirmed productivity, timing and sampled work share one definition in both reports. */
export function EngineerMetricGrid({
  analytics,
  team,
}: {
  analytics: EngineerAnalytics;
  team?: EngineerAnalytics;
}) {
  const punctual = analytics.punctualCompletion;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <ResultMetric
        label="Выполнено за смену"
        value={metricNumber(analytics.completedPerRecordedWorkday)}
        note={`${analytics.recordedWorkdays} учтённых смен${team ? ` · ${teamDifference(analytics.completedPerRecordedWorkday, team.completedPerRecordedWorkday)}` : ''}`}
      />
      <ResultMetric
        label="Завершено вовремя"
        value={metricNumber(punctual.rate === null ? null : punctual.rate * 100, '%')}
        tone="good"
        note={`${punctual.count} из ${punctual.sampleCount} с сохранённым сроком`}
      />
      <ResultMetric
        label="Задержка на заявку"
        value={metricNumber(punctual.averageLatenessMinutes, ' мин')}
        tone={
          punctual.averageLatenessMinutes && punctual.averageLatenessMinutes > 0
            ? 'warning'
            : 'plain'
        }
        note={`По ${punctual.sampleCount} измеренным завершениям, включая нулевую задержку`}
      />
      <ResultMetric
        label="Среднее время работы"
        value={metricNumber(analytics.measuredDuration.averageMinutes, ' мин')}
        note={`${analytics.measuredDuration.sampleCount} пар отметок начала и конца`}
      />
      <ResultMetric
        label="Работа с отметками"
        value={metricNumber(analytics.utilization.recordedWorkMinutes, ' мин')}
        note={`Из ${metricNumber(analytics.utilization.scheduledMinutes)} мин учтённых смен`}
      />
      <ResultMetric
        label="Подтверждённая занятость"
        value={metricNumber(
          analytics.utilization.rate === null ? null : analytics.utilization.rate * 100,
          '%',
        )}
        note="Только работа между отметками; дорога и работа без отметок сюда не входят"
      />
    </div>
  );
}

/** Calendar bars show confirmed finishes; zero days are explicit and never assumed work. */
export function CompletionChart({
  rows,
}: {
  rows: readonly { workDate: string; completed: number }[];
}) {
  if (!rows.length)
    return (
      <p className="rounded-2xl bg-white p-5 text-sm text-figma-dim">
        За этот период пока нет данных для графика.
      </p>
    );
  const max = Math.max(0, ...rows.map((row) => row.completed));
  const scale = Math.max(1, max);
  return (
    <section className="rounded-3xl bg-white p-5 sm:p-6" aria-label="Выполненные заявки по дням">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold">Ритм месяца</h3>
        <span className="text-xs text-figma-dim">
          Подтверждённые завершения · максимум {max} в день
        </span>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max items-end gap-2">
          {rows.map((row) => (
            <div
              key={row.workDate}
              className="flex w-7 flex-col items-center gap-2"
              title={`${row.workDate}: ${row.completed} выполнено`}
            >
              <span className="text-xs font-semibold tabular-nums">{row.completed}</span>
              <div
                className="flex h-28 w-5 items-end rounded-full bg-figma-soft"
                aria-hidden="true"
              >
                <div
                  className="w-full rounded-full bg-figma-work"
                  style={{ height: `${(row.completed / scale) * 100}%` }}
                />
              </div>
              <span className="text-xs text-figma-dim">{row.workDate.slice(-2)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
