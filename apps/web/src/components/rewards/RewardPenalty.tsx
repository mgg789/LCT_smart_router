import { useEffect, useRef, useState } from 'react';
import { loadRewardFacts, penalizeReward, type RewardFact } from '../../api/rewards';

const FACT_LABELS: Record<string, string> = {
  started: 'Начало работы',
  finished: 'Завершение работы',
  eta_reported: 'Время прибытия',
  delayed: 'Дополнительное время',
  arrived: 'Прибытие',
  problem: 'Проблема',
};

/** Requires an explicit recorded fact and a detailed, visible explanation for every deduction. */
export function RewardPenalty({
  token,
  engineerId,
  onSaved,
}: {
  token: string;
  engineerId: string;
  onSaved: () => void;
}) {
  const [facts, setFacts] = useState<RewardFact[] | null>(null);
  const [factId, setFactId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    void retry; // User-requested reload of eligible evidence.
    let disposed = false;
    setFacts(null);
    setError(null);
    void loadRewardFacts(token, engineerId)
      .then((result) => {
        if (!disposed) setFacts(result.facts);
      })
      .catch(() => {
        if (!disposed) setError('Не удалось загрузить отметки.');
      });
    return () => {
      disposed = true;
    };
  }, [token, engineerId, retry]);
  const selected = facts?.find((fact) => fact.id === factId);
  const submit = async () => {
    if (!selected || reason.trim().length < 30 || !confirmed || busy) return;
    const key = JSON.stringify([selected.id, reason.trim()]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      await penalizeReward(token, engineerId, {
        operationId: attempt.current.id,
        requestId: selected.requestId,
        factId: selected.id,
        reason: reason.trim(),
      });
      window.dispatchEvent(new Event('engineer-rewards-changed'));
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить нарушение.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="mt-5 rounded-2xl border border-figma-danger/30 bg-white p-4">
      <summary className="cursor-pointer font-semibold">
        Зафиксировать недостоверную отметку · −50
      </summary>
      <p className="mt-3 text-sm text-figma-dim">
        Укажите, какая отметка не соответствует действительности и чем это подтверждено. Объяснение
        будет видно инженеру в журнале.
      </p>
      {facts === null ? (
        <p role="status" className="mt-3 text-sm">
          {error ? (
            <button
              type="button"
              className="underline"
              onClick={() => setRetry((value) => value + 1)}
            >
              Повторить загрузку отметок
            </button>
          ) : (
            'Загружаем отметки…'
          )}
        </p>
      ) : facts.length === 0 ? (
        <p className="mt-3 text-sm">Нет отметок, доступных для фиксации нарушения.</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="mt-4 grid gap-3"
        >
          <label className="grid gap-2 text-sm font-semibold">
            Отметка инженера
            <select
              disabled={busy}
              required
              value={factId}
              onChange={(event) => {
                setFactId(event.target.value);
                setConfirmed(false);
              }}
              className="w-full rounded-xl border border-figma-hint px-3 py-3 font-normal"
            >
              <option value="">Выберите отметку</option>
              {facts.map((fact) => (
                <option key={fact.id} value={fact.id}>
                  {FACT_LABELS[fact.kind] ?? fact.kind} ·{' '}
                  {new Date(fact.occurredAt * 1000).toLocaleString('ru-RU', {
                    timeZone: 'Europe/Moscow',
                  })}{' '}
                  · {fact.request.addressText}
                </option>
              ))}
            </select>
          </label>
          {selected?.note ? (
            <p className="whitespace-pre-wrap break-words rounded-xl bg-figma-canvas p-3 text-sm">
              {selected.note}
            </p>
          ) : null}
          <label className="grid gap-2 text-sm font-semibold">
            Подробное обоснование
            <textarea
              required
              minLength={30}
              maxLength={2000}
              disabled={busy}
              rows={4}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setConfirmed(false);
              }}
              placeholder="Что было отмечено, что произошло на самом деле и как это проверено (не менее 30 символов)"
              className="rounded-xl border border-figma-hint p-3 font-normal"
            />
          </label>
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              required
              disabled={busy}
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-1"
            />
            Подтверждаю факт нарушения и списание 50 баллов
          </label>
          <button
            type="submit"
            disabled={busy || !selected || reason.trim().length < 30 || !confirmed}
            className="rounded-xl bg-figma-ink py-3 font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Сохраняем…' : 'Зафиксировать нарушение · −50'}
          </button>
        </form>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-figma-danger">
          {error}
        </p>
      ) : null}
    </details>
  );
}
