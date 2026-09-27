import { useEffect, useState } from 'react';
import {
  downloadMonthlyReport,
  loadMonthlyPerformance,
  type MonthlyPerformance,
} from '../../api/performance';
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
        if (!disposed) setError('Не удалось загрузить месяц. Попробуйте ещё раз.');
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
      setError('Не удалось скачать PDF. Повторите загрузку.');
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="grid gap-2 text-sm font-semibold">
          Отчётный месяц
          <input
            aria-label="Отчётный месяц"
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
          {downloading ? 'Готовим PDF…' : 'Скачать PDF'}
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
            Повторить
          </button>
        </div>
      ) : null}
      {!month ? (
        <p>Выберите месяц для отчёта.</p>
      ) : !data && !error ? (
        <p role="status">Собираем факты и показатели команды…</p>
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
            ? 'Месяц продолжается · предварительные данные'
            : 'Сохранённый итог месяца'}
        </p>
        <h3 className="mt-2 text-2xl font-bold">Команда в цифрах</h3>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/70">
          Объём работы, соблюдение сроков и вклад каждого инженера. Сравнивайте показатели с учётом
          сложности заявок, транспорта и полноты отметок.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ResultMetric label="Выполнено с отметкой" value={report.totals.completed} tone="good" />
        <ResultMetric
          label="Заявок за смену"
          value={metricNumber(team?.completedPerRecordedWorkday)}
          note="Среднее по учтённым сменам инженеров"
        />
        <ResultMetric
          label="Средняя задержка"
          value={metricNumber(team?.punctualCompletion.averageLatenessMinutes, ' мин')}
          note="На завершение с сохранённым сроком"
          tone={team?.punctualCompletion.averageLatenessMinutes ? 'warning' : 'plain'}
        />
        <ResultMetric
          label="Инженеров в отчёте"
          value={report.totals.engineerCount}
          note={`${team?.recordedWorkdays ?? '—'} учтённых смен`}
        />
      </div>
      <CompletionChart rows={chartRows} />
      <div className="grid gap-3 sm:grid-cols-3">
        <ResultMetric
          label="Работа с отметками"
          value={metricNumber(report.totals.workMinutes / 60, ' ч')}
        />
        <ResultMetric
          label="Отменено заявок"
          value={report.totals.cancelled}
          tone="warning"
          note="Отмена сама по себе не означает ошибку инженера"
        />
        <ResultMetric
          label="Без подтверждения"
          value={report.totals.assumedCompleted}
          note="Прошли по расписанию; показаны отдельно от факта"
        />
      </div>
      <section className="rounded-3xl bg-white p-5 sm:p-6">
        <h3 className="text-xl font-bold">Вклад инженеров</h3>
        <p className="mt-2 text-sm leading-relaxed text-figma-dim">
          Заявки за учтённую смену. Пунктир — среднее команды: общее число выполнений / число смен.
          Раскройте инженера, чтобы увидеть сроки, длительность и полноту измерений.
        </p>
        {!analytics ? (
          <p className="mt-4 rounded-xl bg-figma-soft p-4 text-sm">
            В этом сохранённом отчёте нет подробных измерений. Исторические показатели не
            пересчитывались.
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
                      <strong className="tabular-nums">{metricNumber(value)}</strong> за смену ·{' '}
                      {engineer.completed} всего
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
                    <p className="text-sm text-figma-dim">Подробные измерения не сохранены.</p>
                  )}
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                    <span>
                      Баллы: <strong>{engineer.points}</strong>
                    </span>
                    <span className="text-figma-work">Начислено: +{engineer.earnedPoints}</span>
                    <span className="text-figma-danger">
                      Корректировки: {engineer.penaltyPoints}
                    </span>
                    <span>Работа: {metricNumber(engineer.workMinutes, ' мин')}</span>
                  </div>
                </div>
              </details>
            );
          })}
          {!report.engineers.length ? (
            <p className="py-4 text-sm text-figma-dim">
              В выбранном месяце инженеров с данными нет.
            </p>
          ) : null}
        </div>
      </section>
      <details className="rounded-2xl bg-white p-5 text-sm leading-relaxed">
        <summary className="cursor-pointer font-semibold">
          Как читать показатели и где не хватает данных
        </summary>
        <p className="mt-3">
          Срок сравнивается с сохранённым обещанным завершением, а не с текущим перепланированным
          маршрутом. Задержка — среднее превышение этого срока по измеренным заявкам, включая нули.
          Без сохранённого срока заявка не участвует в этом показателе.
        </p>
        <p className="mt-3">
          Подтверждённая занятость учитывает только пары отметок начала и конца работ. Это часть
          смены, а не полная загрузка: время дороги и работа без отметок не измерены. Оценки
          клиентов, повторные обращения и решение с первого визита пока не собираются.
        </p>
        {report.notes.map((note) => (
          <p key={note} className="mt-3 text-figma-dim">
            {note}
          </p>
        ))}
      </details>
    </div>
  );
}
