import { useEffect, useState } from 'react';
import {
  loadRewards,
  REWARD_LABELS,
  type RewardSummary,
  rewardRatioLabel,
} from '../../api/rewards';
import { RewardBreakdown } from './RewardBreakdown';
import { RewardDialog } from './RewardDialog';
import { RewardPenalty } from './RewardPenalty';

/** Explains the month score and keeps the evidence journal available to both roles. */
export function RewardDetails({
  token,
  engineerId,
  open,
  onClose,
}: {
  token: string;
  engineerId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<RewardSummary | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    void retry; // Explicit reload after a failed read or a saved adjustment.
    if (!open) return;
    let disposed = false;
    setData(null);
    setError(false);
    void loadRewards(token, engineerId)
      .then((value) => {
        if (!disposed) setData(value);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
    };
  }, [open, token, engineerId, retry]);
  return (
    <RewardDialog open={open} title="Вклад в работу команды" onClose={onClose}>
      {data ? (
        <>
          <div className="mb-5 rounded-3xl bg-figma-ink p-6 text-white">
            <p className="text-sm text-white/60">{data.month}</p>
            <p className="mt-2 font-murs text-5xl text-figma-bee">{data.monthlyPoints}</p>
            <p className="mt-4 font-semibold">{rewardRatioLabel(data.teamRatio)}</p>
            {data.teamAverage !== null ? (
              <p className="mt-1 text-sm text-white/60">
                Среднее команды:{' '}
                {data.teamAverage.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}
              </p>
            ) : null}
          </div>
          <RewardBreakdown categories={data.categories} />
          <details className="mt-5 rounded-2xl bg-white p-4">
            <summary className="cursor-pointer font-semibold">Как получить баллы</summary>
            <ul className="mt-3 grid gap-2 text-sm text-figma-dim">
              <li>Прибытие по плану — 40, по заранее обновлённому ETA — 30.</li>
              <li>Работа в норматив — 40, в продлённое время — 30.</li>
              <li>Актуализация паспорта — 35.</li>
              <li>
                Для нового времени точность — от 10 минут до срока до самого срока. Бонусы 40 и 30
                за одно действие не складываются.
              </li>
              <li>
                Автоматических списаний нет. Подтверждённое диспетчером нарушение статуса — −50 с
                объяснением в журнале.
              </li>
            </ul>
          </details>
          {engineerId ? (
            <RewardPenalty
              token={token}
              engineerId={engineerId}
              onSaved={() => setRetry((value) => value + 1)}
            />
          ) : null}
          <h3 className="mb-3 mt-6 font-semibold">Последние записи</h3>
          {data.recentEntries.length === 0 ? (
            <p className="text-sm text-figma-dim">В этом месяце пока нет начислений.</p>
          ) : (
            <ol className="grid gap-3">
              {data.recentEntries.map((entry) => (
                <li key={entry.id} className="rounded-2xl bg-white p-4">
                  <div className="flex justify-between gap-4">
                    <span className="text-sm font-semibold">{REWARD_LABELS[entry.category]}</span>
                    <strong className={entry.points < 0 ? 'text-figma-danger' : ''}>
                      {entry.points > 0 ? '+' : ''}
                      {entry.points}
                    </strong>
                  </div>
                  <time className="mt-1 block text-xs text-figma-dim">
                    {new Date(entry.awardedAt * 1000).toLocaleString('ru-RU', {
                      timeZone: 'Europe/Moscow',
                    })}
                  </time>
                  {entry.category === 'penalty' ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{entry.reason}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : error ? (
        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="rounded-2xl bg-white p-4"
        >
          Не удалось загрузить баллы. Повторить
        </button>
      ) : (
        <p role="status">Загружаем журнал…</p>
      )}
    </RewardDialog>
  );
}
