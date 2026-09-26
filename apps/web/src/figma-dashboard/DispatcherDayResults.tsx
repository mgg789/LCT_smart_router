import { useEffect, useState } from 'react';
import type { DispatchLiveView } from '../api/live';
import {
  type DayPerformance,
  downloadMonthlyReport,
  loadDayPerformance,
  shouldShowDayResults,
} from '../api/performance';
import type { DispatchShiftView, RequestView } from '../api/types';
import { RewardDialog } from '../components/rewards/RewardDialog';
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
  const [month, setMonth] = useState(currentMonth);
  const [downloading, setDownloading] = useState(false);
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
        if (!disposed) setError('Не удалось загрузить итоги.');
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
      setError(cause instanceof Error ? cause.message : 'Не удалось закрыть смену.');
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      await downloadMonthlyReport(token, month);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить PDF.');
    } finally {
      setDownloading(false);
    }
  };
  return (
    <RewardDialog
      open={open}
      title={ready || shift?.closedAt ? 'День под контролем' : 'Результат рабочего дня'}
      onClose={dismiss}
    >
      {!workdayId ? (
        <p>Начните рабочий день, чтобы собирать результаты.</p>
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
              <p className="font-bold">Качество управления</p>
              <p className="mt-1 text-sm text-white/60">
                {data.score.evaluated ? data.workDate : 'Пока нет решений для оценки'}
              </p>
            </div>
          </div>
          <div className="mb-5 grid grid-cols-3 gap-3">
            {[
              [data.actual.completed, 'Выполнено с отметкой'],
              [data.alerts.resolved, 'Алертов решено'],
              [data.engineerCount, 'Инженеров'],
            ].map(([value, label]) => (
              <div key={label} className="rounded-2xl bg-white p-4">
                <strong className="font-murs text-3xl">{value}</strong>
                <p className="mt-2 text-xs text-figma-dim">{label}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-3">
            {[
              { label: 'Алерты · 70%', item: data.score.alertProcessing },
              { label: 'Выбор политики · 30%', item: data.score.policyChoice },
            ].map(({ label, item }) => (
              <div key={label} className="rounded-2xl bg-white p-4">
                <div className="flex justify-between gap-3">
                  <h3 className="font-semibold">{String(label)}</h3>
                  <span className="font-bold">
                    {item.evaluated ? `${Math.round(item.score)}/100` : 'Нет оценки'}
                  </span>
                </div>
                <p className="mt-2 text-sm text-figma-dim">{item.explanation}</p>
              </div>
            ))}
          </div>
          <details className="mt-5 text-sm text-figma-dim">
            <summary className="cursor-pointer font-semibold text-figma-ink">
              Как рассчитывается качество
            </summary>
            <p className="mt-2">
              Алерты: оперативное ручное — 100; своевременное ручное — 90; своевременное AI — 80;
              долгое ручное — 65; оперативное AI — 55; долгое AI — 40; в конце дня — 10. Оперативно
              — до 2 минут, своевременно — до 10 минут.
            </p>
            <p className="mt-2">{data.policy.explanation}</p>
          </details>
          <TomorrowList rows={tomorrow} />
          {data.actual.assumedCompleted > 0 ? (
            <p className="mt-4 text-sm text-figma-dim">
              По расписанию без подтверждения: {data.actual.assumedCompleted}. Это отдельно от
              фактически выполненных задач.
            </p>
          ) : null}
          {!ready && !shift?.closedAt ? (
            <p className="mt-5 rounded-2xl bg-white p-4 text-sm">
              Итоги предварительные. Закрытие доступно после завершения работ и решения всех
              блокирующих алертов.
            </p>
          ) : null}
          {ready ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void complete()}
              className="mt-6 w-full rounded-2xl bg-figma-bee py-4 font-bold disabled:opacity-50"
            >
              {busy ? 'Сохраняем итог…' : 'Сохранить результат и завершить день'}
            </button>
          ) : null}
        </>
      ) : !error ? (
        <p role="status">Собираем результаты дня…</p>
      ) : null}
      <div className="mt-6 border-t border-figma-hint/40 pt-5">
        <label className="grid gap-2 text-sm font-semibold">
          Месячный отчёт команды
          <input
            type="month"
            value={month}
            max={currentMonth}
            onChange={(event) => setMonth(event.target.value)}
            className="rounded-xl bg-white px-3 py-3 font-normal"
          />
        </label>
        <button
          type="button"
          disabled={downloading || !month || month > currentMonth}
          onClick={() => void download()}
          className="mt-3 w-full rounded-xl bg-figma-ink py-3 font-semibold text-white disabled:opacity-50"
        >
          {downloading ? 'Готовим PDF…' : 'Скачать PDF'}
        </button>
        <p className="mt-2 text-xs text-figma-dim">
          Текущий месяц — предварительный. Итоговый отчёт приходит на почту 1-го числа.
        </p>
      </div>
      {error ? (
        <div role="alert" className="mt-4 text-figma-danger">
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
    </RewardDialog>
  );
}

/** Expandable table of the next day's visits, morning first. */
function TomorrowList({ rows }: { rows: ReturnType<typeof tomorrowRequestRows> }) {
  return (
    <details className="mt-5 rounded-2xl bg-white p-4">
      <summary className="cursor-pointer font-semibold text-figma-ink">
        Заявок на завтра {rows.length}
      </summary>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-figma-dim">На следующий день заявок нет.</p>
      ) : (
        <table className="mt-3 w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-figma-dim">
              <th className="pb-2 font-semibold">Номер</th>
              <th className="pb-2 font-semibold">Тип</th>
              <th className="pb-2 font-semibold">Окно</th>
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
