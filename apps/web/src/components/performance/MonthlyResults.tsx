import { useEffect, useState } from 'react';
import {
  downloadMonthlyReport,
  loadMonthlyPerformance,
  type MonthlyPerformance,
} from '../../api/performance';
import { t } from '../../i18n';
import {
  CompletionChart,
  EngineerMetricGrid,
  metricNumber,
  ResultMetric,
} from './PerformanceVisuals';

/** Monthly screen reads the same frozen or provisional report used by the PDF export. */
export function MonthlyResults({
  token,
  initialMonth,
  currentMonth,
}: {
  token: string;
  initialMonth: string;
  currentMonth: string;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<MonthlyPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    void retry;
    let disposed = false;
    setData(null);
    setError(null);
    if (!/^\d{4}-\d{2}$/.test(month) || month > currentMonth) return;
    void loadMonthlyPerformance(token, month)
      .then((result) => {
        if (!disposed) setData(result);
      })
      .catch(() => {
        if (!disposed) setError(t('components.performance.MonthlyResults.8643b83dea'));
      });
    return () => {
      disposed = true;
    };
  }, [token, month, currentMonth, retry]);
  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      await downloadMonthlyReport(token, month);
    } catch {
      setError(t('components.performance.MonthlyResults.7f923c318a'));
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="grid gap-2 text-sm font-semibold">
          {t('components.performance.MonthlyResults.b7325066cd')}
          <input
            aria-label={t('components.performance.MonthlyResults.b7325066cd')}
            type="month"
            value={month}
            max={currentMonth}
            onChange={(event) => setMonth(event.target.value)}
            className="rounded-xl bg-white px-4 py-3 font-normal"
          />
        </label>
        <button
          type="button"
          disabled={!data || downloading}
          onClick={() => void download()}
          className="rounded-full bg-figma-ink px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {downloading
            ? t('components.performance.MonthlyResults.393b1cb68b')
            : t('components.performance.MonthlyResults.a859d91f58')}
        </button>
      </div>
      {error ? (
        <div role="alert" className="rounded-2xl bg-figma-danger/10 p-4 text-figma-danger">
          {error}{' '}
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="underline"
          >
            {t('components.performance.MonthlyResults.5189135a61')}
          </button>
        </div>
      ) : null}
      {!month ? (
        <p>{t('components.performance.MonthlyResults.13ddaf237b')}</p>
      ) : !data && !error ? (
        <p role="status">{t('components.performance.MonthlyResults.7aa1455e90')}</p>
      ) : null}
      {data ? <MonthlyReportContent report={data} /> : null}
    </div>
  );
}

/** The report avoids an overall employee score; each indicator retains its sample size. */
export function MonthlyReportContent({ report }: { report: MonthlyPerformance }) {
  const analytics = report.analytics;
  const team = analytics?.team;
  const series = new Map(report.days.map((day) => [day.workDate, day.completed]));
  for (const day of analytics?.dailySeries ?? []) series.set(day.workDate, day.completed);
  const chartRows = [...series]
    .map(([workDate, completed]) => ({ workDate, completed }))
    .sort((left, right) => left.workDate.localeCompare(right.workDate));
  const maximum = Math.max(
    1,
    ...(analytics?.engineers.map((row) => row.completedPerRecordedWorkday ?? 0) ?? []),
    team?.completedPerRecordedWorkday ?? 0,
  );
  return (
    <div className="space-y-6">
      <div className="rounded-3xl bg-figma-ink p-6 text-white">
        <p className="text-sm text-white/70">
          {report.provisional
            ? t('components.performance.MonthlyResults.205ab36d96')
            : t('components.performance.MonthlyResults.cd7329c9dc')}
        </p>
        <h3 className="mt-2 text-2xl font-bold">
          {t('components.performance.MonthlyResults.4b6c5d5f32')}
        </h3>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/70">
          {t('components.performance.MonthlyResults.608b44b3ce')}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ResultMetric
          label={t('components.performance.MonthlyResults.56cef76480')}
          value={report.totals.completed}
          tone="good"
        />
        <ResultMetric
          label={t('components.performance.MonthlyResults.03dcb2a3a7')}
          value={metricNumber(team?.completedPerRecordedWorkday)}
          note={t('components.performance.MonthlyResults.e343bc1219')}
        />
        <ResultMetric
          label={t('components.performance.MonthlyResults.4072a8024d')}
          value={metricNumber(
            team?.punctualCompletion.averageLatenessMinutes,
            t('components.performance.MonthlyResults.84d5d93d12'),
          )}
          note={t('components.performance.MonthlyResults.c4cc18c651')}
          tone={team?.punctualCompletion.averageLatenessMinutes ? 'warning' : 'plain'}
        />
        <ResultMetric
          label={t('components.performance.MonthlyResults.d7d95e425c')}
          value={report.totals.engineerCount}
          note={t('components.performance.MonthlyResults.fcb69441e8', {
            value0: team?.recordedWorkdays ?? '—',
          })}
        />
      </div>
      <CompletionChart rows={chartRows} />
      <div className="grid gap-3 sm:grid-cols-3">
        <ResultMetric
          label={t('components.performance.MonthlyResults.a5c5fe5f1e')}
          value={metricNumber(
            report.totals.workMinutes / 60,
            t('components.performance.MonthlyResults.e34d885124'),
          )}
        />
        <ResultMetric
          label={t('components.performance.MonthlyResults.1da6a379ba')}
          value={report.totals.cancelled}
          tone="warning"
          note={t('components.performance.MonthlyResults.5a8ede220d')}
        />
        <ResultMetric
          label={t('components.performance.MonthlyResults.ce6dfbb144')}
          value={report.totals.assumedCompleted}
          note={t('components.performance.MonthlyResults.a5e724fb9c')}
        />
      </div>
      <section className="rounded-3xl bg-white p-5 sm:p-6">
        <h3 className="text-xl font-bold">
          {t('components.performance.MonthlyResults.81903ec414')}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-figma-dim">
          {t('components.performance.MonthlyResults.cdbbd1c2d8')}
        </p>
        {!analytics ? (
          <p className="mt-4 rounded-xl bg-figma-soft p-4 text-sm">
            {t('components.performance.MonthlyResults.b6451c930e')}
          </p>
        ) : null}
        <div className="mt-5 space-y-3">
          {report.engineers.map((engineer) => {
            const item = analytics?.engineers.find((row) => row.engineerId === engineer.engineerId);
            const value = item?.completedPerRecordedWorkday;
            return (
              <details
                key={engineer.engineerId}
                className="group rounded-2xl border border-figma-hint/30 bg-figma-soft p-4"
              >
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="font-semibold">
                      {engineer.name}
                      <span className="ml-2 text-figma-muted group-open:hidden">＋</span>
                    </span>
                    <span className="text-sm">
                      <strong className="tabular-nums">{metricNumber(value)}</strong>
                      {t('components.performance.MonthlyResults.8222128690')} {engineer.completed}
                      {t('components.performance.MonthlyResults.7df1979c21')}
                    </span>
                  </div>
                  <div className="relative mt-3 h-3 rounded-full bg-white" aria-hidden="true">
                    <div
                      className="h-full rounded-full bg-figma-bee"
                      style={{ width: `${((value ?? 0) / maximum) * 100}%` }}
                    />
                    {team?.completedPerRecordedWorkday != null ? (
                      <span
                        className="absolute -top-1 h-5 border-l-2 border-dashed border-figma-ink"
                        style={{ left: `${(team.completedPerRecordedWorkday / maximum) * 100}%` }}
                      />
                    ) : null}
                  </div>
                </summary>
                <div className="mt-5 space-y-4">
                  {item ? (
                    <EngineerMetricGrid analytics={item} team={team} />
                  ) : (
                    <p className="text-sm text-figma-dim">
                      {t('components.performance.MonthlyResults.3e07ba19f5')}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <span>
                      {t('components.performance.MonthlyResults.710140aeb6')}
                      <strong>{engineer.points}</strong>
                    </span>
                    <span className="text-figma-work">
                      {t('components.performance.MonthlyResults.dffc8ec5d8')}
                      {engineer.earnedPoints}
                    </span>
                    <span className="text-figma-danger">
                      {t('components.performance.MonthlyResults.8189c7fbec')}
                      {engineer.penaltyPoints}
                    </span>
                    <span>
                      {t('components.performance.MonthlyResults.08887ecd09')}
                      {metricNumber(
                        engineer.workMinutes,
                        t('components.performance.MonthlyResults.84d5d93d12'),
                      )}
                    </span>
                  </div>
                </div>
              </details>
            );
          })}
          {!report.engineers.length ? (
            <p className="py-4 text-sm text-figma-dim">
              {t('components.performance.MonthlyResults.fc9c94ea14')}
            </p>
          ) : null}
        </div>
      </section>
      <details className="rounded-2xl bg-white p-5 text-sm leading-relaxed">
        <summary className="cursor-pointer font-semibold">
          {t('components.performance.MonthlyResults.eb6f992086')}
        </summary>
        <p className="mt-3">{t('components.performance.MonthlyResults.404f4f0bc6')}</p>
        <p className="mt-3">{t('components.performance.MonthlyResults.17535da2b8')}</p>
        {report.notes.map((note) => (
          <p key={note} className="mt-3 text-figma-dim">
            {note}
          </p>
        ))}
      </details>
    </div>
  );
}
