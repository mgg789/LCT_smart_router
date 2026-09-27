import { useEffect, useState } from 'react';
import type { EngineerLiveView } from '../api/live';
import { loadPersonalPerformance, type PersonalPerformance } from '../api/performance';
import {
  loadRewardDay,
  loadRewards,
  type RewardDaySummary,
  type RewardSummary,
  rewardRatioLabel,
} from '../api/rewards';
import {
  EngineerMetricGrid,
  ResultMetric,
  ResultProgress,
} from '../components/performance/PerformanceVisuals';
import { RewardBreakdown } from '../components/rewards/RewardBreakdown';
import { RewardDialog } from '../components/rewards/RewardDialog';

/** Personal completion is independent from unfinished dispatcher alerts and other engineers. */
export function EngineerDayResults({ token, live }: { token: string; live: EngineerLiveView }) {
  const ready = live.engineer.canFinishDay || live.workday.status === 'finished';
  const workdayId = live.workday.id;
  const key = `navix.results.engineer.${live.engineer.id}.${workdayId}`;
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{
    day: RewardDaySummary;
    month: RewardSummary;
    performance: PersonalPerformance;
  } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (ready && workdayId && window.sessionStorage.getItem(key) !== 'seen') setOpen(true);
  }, [ready, workdayId, key]);
  useEffect(() => {
    void retry; // Retry must repeat the read even when the day has not changed.
    if (!open || !workdayId) return;
    let disposed = false;
    setData(null);
    setError(false);
    void Promise.all([
      loadRewardDay(token, workdayId),
      loadRewards(token),
      loadPersonalPerformance(token, workdayId),
    ])
      .then(([day, month, performance]) => {
        if (!disposed) setData({ day, month, performance });
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
    };
  }, [open, token, workdayId, retry]);
  if (!ready || !workdayId) return null;
  const close = () => {
    window.sessionStorage.setItem(key, 'seen');
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute bottom-6 inset-x-6 z-40 rounded-2xl bg-figma-bee px-6 py-4 font-bold text-figma-ink shadow-lg"
      >
        Мой результат дня
      </button>
      <RewardDialog open={open} title="Смена в копилке" onClose={close}>
        <p className="mb-5 text-figma-dim">Ваши отметки помогли точнее планировать день.</p>
        {data ? (
          <>
            <div className="mb-5 rounded-3xl bg-figma-ink p-6 text-white">
              <div className="flex items-center gap-3">
                <strong className="font-murs text-6xl text-figma-bee">
                  +{data.day.earnedPoints}
                </strong>
                <img
                  src="/figma/carambola.svg"
                  alt="баллов за день"
                  className="size-10 rounded-full bg-figma-bee p-1"
                />
              </div>
              <p className="mt-3 text-sm text-white/70">
                Заработано за смену · {data.month.monthlyPoints} за месяц
              </p>
              <p className="mt-4 font-semibold">
                За месяц: {rewardRatioLabel(data.month.teamRatio)}
              </p>
            </div>
            <div className="mb-5 grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-figma-bee p-4">
                <strong className="font-murs text-3xl">
                  {data.performance.engineer?.completed ?? live.engineer.stats.completedCount}
                </strong>
                <p className="mt-1 text-sm">Задач выполнено с отметкой</p>
              </div>
              <div className="rounded-2xl bg-white p-4">
                <strong className="font-murs text-3xl">
                  {data.day.entries.filter((entry) => entry.points > 0).length}
                </strong>
                <p className="mt-1 text-sm">Полезных действий с наградой</p>
              </div>
            </div>
            {data.performance.analytics ? (
              <section className="mb-5 space-y-4">
                <h3 className="text-xl font-bold">Ваш день в деталях</h3>
                <div className="rounded-2xl bg-white p-4">
                  <ResultProgress
                    label="Завершения вовремя"
                    value={data.performance.analytics.punctualCompletion.count}
                    total={data.performance.analytics.punctualCompletion.sampleCount}
                  />
                </div>
                <EngineerMetricGrid analytics={data.performance.analytics} />
                <p className="text-xs leading-relaxed text-figma-dim">
                  Сроки сравниваем с сохранённым обещанным завершением. Работа без отметок и дорога
                  не входят в подтверждённую занятость.
                </p>
              </section>
            ) : (
              <p className="mb-5 text-sm text-figma-dim">
                Подробные измерения сроков для этой смены не сохранены.
              </p>
            )}
            {(data.performance.engineer?.cancelled ?? 0) > 0 ? (
              <div className="mb-5">
                <ResultMetric
                  value={data.performance.engineer?.cancelled ?? 0}
                  label="Отменённых заявок"
                  note="Причины отмены учитываются отдельно от вашего результата"
                  tone="warning"
                />
              </div>
            ) : null}
            <h3 className="mb-3 text-xl font-bold">Из чего сложились баллы</h3>
            <RewardBreakdown categories={data.day.categories} />
            {(data.performance.engineer?.assumedCompleted ??
              live.engineer.stats.assumedCompletedCount) > 0 ? (
              <p className="mt-4 text-sm text-figma-dim">
                Ещё{' '}
                {data.performance.engineer?.assumedCompleted ??
                  live.engineer.stats.assumedCompletedCount}{' '}
                задач прошло по расписанию без отметки. За них баллы не начисляются.
              </p>
            ) : null}
            <p className="mt-5 text-sm text-figma-dim">
              Следующая цель: точное прибытие +40, работа в норматив +40, паспорт объекта +35.
              Скорость сама по себе дополнительных баллов не даёт.
            </p>
          </>
        ) : error ? (
          <button
            type="button"
            onClick={() => setRetry((value) => value + 1)}
            className="rounded-2xl bg-white p-4"
          >
            Не удалось загрузить результат. Повторить
          </button>
        ) : (
          <p role="status">Собираем ваши достижения…</p>
        )}
        <button
          type="button"
          onClick={close}
          className="mt-6 w-full rounded-2xl bg-figma-bee py-4 font-bold"
        >
          Отлично, до следующей смены
        </button>
      </RewardDialog>
    </>
  );
}
