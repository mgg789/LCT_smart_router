import { useState } from 'react';
import type { useDashboard } from '../hooks/useDashboard';
import { POLICY_LABELS } from '../lib/reasons';

/** Presents data provenance and redacted diagnostics without hiding the original failure. */
export function ConnectionBar({
  dashboard: d,
}: {
  readonly dashboard: ReturnType<typeof useDashboard>;
}) {
  const [copied, setCopied] = useState(false);
  const label =
    d.source === 'demo'
      ? 'Демо-сценарий · записанный расчёт'
      : d.source === 'cached'
        ? 'Связь потеряна · сохранённый план'
        : 'Подключено';
  const details = {
    source: d.source,
    version: import.meta.env.VITE_APP_VERSION ?? 'local',
    planRevision: d.snapshot?.plan.plan?.revision ?? null,
    lastSuccessfulRead: d.savedAt ? new Date(d.savedAt).toISOString() : null,
    durableForThisSession: d.cacheAvailable,
    lastFailure: d.diagnostic,
    operationResultUnconfirmed: d.operationWarning !== null,
  };
  return (
    <section
      aria-label="Источник данных"
      className="mx-4 mb-3 rounded-xl border border-line bg-white px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <strong>{label}</strong>
        {d.savedAt && !d.isDemo ? (
          <span className="text-muted">
            Получен {new Date(d.savedAt).toLocaleTimeString('ru-RU')}
          </span>
        ) : null}
        {d.isDemo ? (
          <>
            <select
              aria-label="Демо-сценарий"
              value={d.scenarioId}
              onChange={(e) => d.selectDemoScenario(e.target.value)}
              className="rounded-lg border border-line p-2"
            >
              {d.demoScenarios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
            <select
              aria-label="Записанная политика"
              value={d.snapshot?.policyId}
              onChange={(e) => {
                const policy = d.snapshot?.policies.find(
                  (item) => item.policyId === e.target.value,
                );
                if (policy) d.selectDemoScenario(d.scenarioId, policy.policyId);
              }}
              className="rounded-lg border border-line p-2"
            >
              {d.snapshot?.policies.map((item) => (
                <option key={item.policyId} value={item.policyId}>
                  {POLICY_LABELS[item.policyId]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => d.selectDemoScenario('initial')}
              className="underline"
            >
              Начать заново
            </button>
            <button type="button" onClick={d.leaveDemo} className="underline">
              Вернуться к серверу
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={d.busy}
              onClick={() => void d.refresh()}
              className="underline disabled:opacity-50"
            >
              Проверить связь
            </button>
            <button
              type="button"
              disabled={d.busy}
              onClick={() => d.selectDemoScenario('initial')}
              className="underline disabled:opacity-50"
            >
              Открыть демо
            </button>
          </>
        )}
        <details className="ml-auto max-w-full">
          <summary className="cursor-pointer text-muted">Диагностика</summary>
          <p className="mt-2 max-w-sm text-xs text-muted">
            Сведения о состоянии данных для разработчика. Эта панель не запускает тесты и ничего не
            исправляет.
          </p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">
            {JSON.stringify(details, null, 2)}
          </pre>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => {
              void navigator.clipboard
                .writeText(JSON.stringify(details, null, 2))
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? 'Скопировано' : 'Скопировать диагностику'}
          </button>
        </details>
      </div>
      {d.source !== 'live' ? (
        <p className="mt-2 text-muted">
          {d.isDemo
            ? 'Учебный набор: 17 августа 2026. Сценарии работают локально; действия на сервер не отправляются. Время расчёта в таблице не замерялось.'
            : 'Просмотр доступен. Изменения заблокированы до восстановления связи.'}
        </p>
      ) : null}
      {d.operationWarning ? (
        <p role="status" className="mt-2 text-ink">
          {d.operationWarning}{' '}
          <button type="button" className="underline" onClick={d.dismissOperationWarning}>
            Прочитано
          </button>
        </p>
      ) : null}
    </section>
  );
}
