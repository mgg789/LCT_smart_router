import { useEffect, useState } from 'react';
import type { DispatchLiveView } from '../api/live';
import { type DayPerformance, loadDayPerformance, shouldShowDayResults } from '../api/performance';
import type { DispatchShiftView, RequestView } from '../api/types';
import { MonthlyResults } from '../components/performance/MonthlyResults';
import {
  EngineerMetricGrid,
  metricNumber,
  ResultMetric,
  ResultProgress,
} from '../components/performance/PerformanceVisuals';
import { RewardDialog } from '../components/rewards/RewardDialog';
import { t } from '../i18n';
import { formatClock } from '../lib/time';
import { tomorrowRequestRows } from './tomorrowRequests';

/** Opens once execution finishes and the final blocking alert has a recorded outcome. */
export function DispatcherDayResults({
  token,
  live,
  shift,
  open,
  onOpen,
  onClose,
  closeShift,
  requests = [],
  workDate = null,
}: {
  token: string;
  live: DispatchLiveView | null;
  shift: DispatchShiftView | undefined;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  closeShift: (workDate: string, operationId: string) => Promise<void>;
  /** Day's request list. Tomorrow's rows are the ones whose window starts the next Moscow day. */
  requests?: readonly Pick<
    RequestView,
    'id' | 'lifecycle' | 'windowStartAt' | 'windowEndAt' | 'workTypeTitle'
  >[];
  workDate?: string | null;
}) {
  const [data, setData] = useState<DayPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const currentMonth = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
  const [view, setView] = useState<'day' | 'month'>('day');
  const workdayId = live?.workday.id;
  const day = workDate ?? live?.workday.workDate ?? null;
  const tomorrow = day ? tomorrowRequestRows(requests, day) : [];
  const ready = shouldShowDayResults(live?.workday.status, shift?.unresolvedCount, shift?.closedAt);
  const key = `navix.results.dispatcher.${workdayId}`;
  useEffect(() => {
    if (ready && workdayId && window.sessionStorage.getItem(key) !== 'seen') onOpen();
  }, [ready, workdayId, key, onOpen]);
  useEffect(() => {
    void retry; // Retry must repeat the read even when the day has not changed.
    if (!open || !workdayId) return;
    let disposed = false;
    setData(null);
    setError(null);
    void loadDayPerformance(token, workdayId)
      .then((value) => {
        if (!disposed) setData(value);
      })
      .catch(() => {
        if (!disposed) setError(t('figma-dashboard.DispatcherDayResults.e8085e5de5'));
      });
    return () => {
      disposed = true;
    };
  }, [open, token, workdayId, retry]);
  const dismiss = () => {
    if (workdayId) window.sessionStorage.setItem(key, 'seen');
    onClose();
  };
  const complete = async () => {
    if (!ready || !data || busy) return;
    setBusy(true);
    setError(null);
    try {
      await closeShift(data.workDate, crypto.randomUUID());
      dismiss();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t('figma-dashboard.DispatcherDayResults.e54145f736'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <RewardDialog
      open={open}
      wide
      title={
        view === 'month'
          ? t('figma-dashboard.DispatcherDayResults.8600b0a65d')
          : ready || shift?.closedAt
            ? t('figma-dashboard.DispatcherDayResults.4dfc5cdb18')
            : t('figma-dashboard.DispatcherDayResults.7dd5922a8a')
      }
      onClose={dismiss}
    >
      <fieldset
        aria-label={t('figma-dashboard.DispatcherDayResults.4578fc4314')}
        className="mb-6 inline-flex gap-1 rounded-full bg-white p-1"
      >
        {(['day', 'month'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => setView(value)}
            className="rounded-full px-6 py-3 text-sm font-semibold transition-colors duration-150 aria-pressed:bg-figma-ink aria-pressed:text-white"
          >
            {value === 'day'
              ? t('figma-dashboard.DispatcherDayResults.63ad4f82c1')
              : t('figma-dashboard.DispatcherDayResults.c908665452')}
          </button>
        ))}
      </fieldset>
      {view === 'month' ? (
        <MonthlyResults token={token} initialMonth={currentMonth} currentMonth={currentMonth} />
      ) : !workdayId ? (
        <p>{t('figma-dashboard.DispatcherDayResults.21fcf49b0a')}</p>
      ) : data ? (
        <>
          <div className="mb-5 grid grid-cols-[auto_1fr] items-center gap-5 rounded-3xl bg-figma-ink p-6 text-white">
            <div>
              <strong className="font-murs text-6xl text-figma-bee">
                {Math.round(data.score.score)}
              </strong>
              <span className="ml-1 text-white/60">/100</span>
            </div>
            <div>
              <p className="font-bold">{t('figma-dashboard.DispatcherDayResults.b46af5cf87')}</p>
              <p className="mt-1 text-sm text-white/60">
                {data.score.evaluated
                  ? data.workDate
                  : t('figma-dashboard.DispatcherDayResults.e233c614cb')}
              </p>
            </div>
          </div>
          <div className="mb-5 grid grid-cols-3 gap-3">
            {[
              [data.actual.completed, t('figma-dashboard.DispatcherDayResults.56cef76480')],
              [data.alerts.resolved, t('figma-dashboard.DispatcherDayResults.8ff64d5aa2')],
              [data.engineerCount, t('figma-dashboard.DispatcherDayResults.1ec49c7b98')],
            ].map(([value, label]) => (
              <div key={label} className="rounded-2xl bg-white p-4">
                <strong className="font-murs text-3xl">{value}</strong>
                <p className="mt-2 text-xs text-figma-dim">{label}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-3">
            {[
              {
                label: t('figma-dashboard.DispatcherDayResults.f89417e392'),
                item: data.score.alertProcessing,
              },
              {
                label: t('figma-dashboard.DispatcherDayResults.8b9a861d81'),
                item: data.score.policyChoice,
              },
            ].map(({ label, item }) => (
              <div key={label} className="rounded-2xl bg-white p-4">
                <div className="flex justify-between gap-3">
                  <h3 className="font-semibold">{String(label)}</h3>
                  <span className="font-bold">
                    {item.evaluated
                      ? `${Math.round(item.score)}/100`
                      : t('figma-dashboard.DispatcherDayResults.57f5e4d640')}
                  </span>
                </div>
                <p className="mt-2 text-sm text-figma-dim">{item.explanation}</p>
              </div>
            ))}
          </div>
          <details className="mt-5 text-sm text-figma-dim">
            <summary className="cursor-pointer font-semibold text-figma-ink">
              {t('figma-dashboard.DispatcherDayResults.a3ac97c3f9')}
            </summary>
            <p className="mt-2">{t('figma-dashboard.DispatcherDayResults.de1d2a1f10')}</p>
            <p className="mt-2">{data.policy.explanation}</p>
          </details>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <ResultMetric
              label={t('figma-dashboard.DispatcherDayResults.a5c5fe5f1e')}
              value={metricNumber(
                data.workMinutes / 60,
                t('figma-dashboard.DispatcherDayResults.e34d885124'),
              )}
              note={t('figma-dashboard.DispatcherDayResults.f42bc9f288')}
            />
            <ResultMetric
              label={t('figma-dashboard.DispatcherDayResults.23a2a9bfcf')}
              value={data.actual.cancelled}
              tone="warning"
            />
            <ResultMetric
              label={t('figma-dashboard.DispatcherDayResults.94a971d038')}
              value={data.actual.assumedCompleted}
              note={t('figma-dashboard.DispatcherDayResults.289de36420')}
            />
          </div>
          <section className="mt-5 space-y-4 rounded-2xl bg-white p-5">
            <h3 className="text-lg font-bold">
              {t('figma-dashboard.DispatcherDayResults.7a62aacae0')}
            </h3>
            <ResultProgress
              label={t('figma-dashboard.DispatcherDayResults.0a4413f049')}
              value={data.alerts.resolved}
              total={data.alerts.significantTotal}
            />
            {data.analytics ? (
              <ResultProgress
                label={t('figma-dashboard.DispatcherDayResults.f987361861')}
                value={data.analytics.team.punctualCompletion.count}
                total={data.analytics.team.punctualCompletion.sampleCount}
              />
            ) : null}
          </section>
          {data.analytics ? (
            <section className="mt-6 space-y-3">
              <h3 className="text-xl font-bold">
                {t('figma-dashboard.DispatcherDayResults.54bd28678f')}
              </h3>
              {data.analytics.engineers.map((engineer) => (
                <details key={engineer.engineerId} className="rounded-2xl bg-white p-5">
                  <summary className="cursor-pointer font-semibold">
                    {engineer.name ?? t('figma-dashboard.DispatcherDayResults.88d71676fa')} ·{' '}
                    {engineer.completed}
                    {t('figma-dashboard.DispatcherDayResults.7a2d425938')}
                  </summary>
                  <div className="mt-4">
                    <EngineerMetricGrid analytics={engineer} />
                  </div>
                </details>
              ))}
            </section>
          ) : data.engineers?.length ? (
            <section className="mt-6 rounded-2xl bg-white p-5">
              <h3 className="font-bold">{t('figma-dashboard.DispatcherDayResults.54bd28678f')}</h3>
              <p className="mt-2 text-sm text-figma-dim">
                {t('figma-dashboard.DispatcherDayResults.7e828bc618')}
              </p>
            </section>
          ) : null}
          {data.nextDay ? (
            <section className="mt-6 rounded-3xl border border-figma-bee bg-figma-bee/10 p-5">
              <h3 className="text-xl font-bold">
                {t('figma-dashboard.DispatcherDayResults.74e30bf284')}
              </h3>
              <p className="mt-2 text-sm text-figma-dim">
                {data.nextDay.workDate}
                {t('figma-dashboard.DispatcherDayResults.49ce03608e')}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <ResultMetric
                  label={t('figma-dashboard.DispatcherDayResults.d2fc6674a0')}
                  value={data.nextDay.openRequestCount}
                />
                <ResultMetric
                  label={t('figma-dashboard.DispatcherDayResults.cc3933994f')}
                  value={data.nextDay.overdueOpenCount}
                  tone={data.nextDay.overdueOpenCount ? 'warning' : 'plain'}
                  note={t('figma-dashboard.DispatcherDayResults.4a9a45e969')}
                />
              </div>
              {data.nextDay.requests.length ? (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-semibold">
                    {t('figma-dashboard.DispatcherDayResults.f040e1a791')}
                    {data.nextDay.requests.length}
                    {t('figma-dashboard.DispatcherDayResults.6350a14dac')}{' '}
                    {data.nextDay.openRequestCount})
                  </summary>
                  <ul className="mt-3 divide-y divide-figma-hint/30">
                    {data.nextDay.requests.map((request) => (
                      <li key={request.requestId} className="py-3 text-sm">
                        <div className="flex flex-wrap justify-between gap-2">
                          <strong>№ {request.arrivalOrder}</strong>
                          <span>
                            {formatClock(request.windowStartAt)}–{formatClock(request.windowEndAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-figma-dim">{request.addressText}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : (
            <TomorrowList rows={tomorrow} />
          )}
          {data.actual.assumedCompleted > 0 ? (
            <p className="mt-4 text-sm text-figma-dim">
              {t('figma-dashboard.DispatcherDayResults.bae218df23')}
              {data.actual.assumedCompleted}
              {t('figma-dashboard.DispatcherDayResults.bc4bfe4995')}
            </p>
          ) : null}
          {!ready && !shift?.closedAt ? (
            <p className="mt-5 rounded-2xl bg-white p-4 text-sm">
              {t('figma-dashboard.DispatcherDayResults.0ce05ec8e6')}
            </p>
          ) : null}
          {ready ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void complete()}
              className="mt-6 w-full rounded-2xl bg-figma-bee py-4 font-bold disabled:opacity-50"
            >
              {busy
                ? t('figma-dashboard.DispatcherDayResults.c6198f0326')
                : t('figma-dashboard.DispatcherDayResults.a5079f00f9')}
            </button>
          ) : null}
        </>
      ) : !error ? (
        <p role="status">{t('figma-dashboard.DispatcherDayResults.a973bba820')}</p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-4 text-figma-danger">
          {error}{' '}
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="underline"
          >
            {t('figma-dashboard.DispatcherDayResults.5189135a61')}
          </button>
        </div>
      ) : null}
    </RewardDialog>
  );
}

/** Expandable table of the next day's visits, morning first. */
function TomorrowList({ rows }: { rows: ReturnType<typeof tomorrowRequestRows> }) {
  return (
    <details className="mt-5 rounded-2xl bg-white p-4">
      <summary className="cursor-pointer font-semibold text-figma-ink">
        {t('figma-dashboard.DispatcherDayResults.d27e0c8816')}
        {rows.length}
      </summary>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-figma-dim">
          {t('figma-dashboard.DispatcherDayResults.db91da4c3a')}
        </p>
      ) : (
        <table className="mt-3 w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-figma-dim">
              <th className="pb-2 font-semibold">
                {t('figma-dashboard.DispatcherDayResults.8624c88200')}
              </th>
              <th className="pb-2 font-semibold">
                {t('figma-dashboard.DispatcherDayResults.d4a6795c19')}
              </th>
              <th className="pb-2 font-semibold">
                {t('figma-dashboard.DispatcherDayResults.9521194df6')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-figma-hint/30">
                <td className="py-2 pr-3 font-semibold">{row.number}</td>
                <td className="py-2 pr-3">{row.type}</td>
                <td className="py-2 whitespace-nowrap">{row.window}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
