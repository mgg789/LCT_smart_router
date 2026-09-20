import { useEffect, useRef, useState } from 'react';
import { DashboardApiError } from '../api/client';
import type { AlertResolutionInput, AlertView, DashboardSnapshot } from '../api/types';
import {
  ALERT_ACTION_LABELS,
  alertDecisionSeconds,
  alertTitle,
  alertWindowInput,
  alertWindowSeconds,
  isOpenAlert,
} from '../domain/alerts';
import { formatClock, formatDayTitle } from '../lib/time';

interface Props {
  readonly snapshot: DashboardSnapshot;
  readonly writesDisabled: boolean;
  readonly onResolve: (id: string, input: AlertResolutionInput) => Promise<void>;
  readonly onSeen: (id: string) => Promise<void>;
  readonly onCloseShift: (date: string, operationId: string) => Promise<void>;
}

/** Persistent decision inbox: transient toast dismissal does not alter these records. */
export function AlertsPage({ snapshot, writesDisabled, onResolve, onSeen, onCloseShift }: Props) {
  const [section, setSection] = useState<'open' | 'history' | 'notices'>('open');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const closeOperation = useRef({ date: snapshot.workDate, id: crypto.randomUUID() });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const open = snapshot.alerts.filter(isOpenAlert);
  const selected = snapshot.alerts.filter((alert) =>
    section === 'notices'
      ? alert.kind === 'notice'
      : section === 'open'
        ? isOpenAlert(alert)
        : alert.kind !== 'notice' && alert.resolvedAt !== null,
  );
  const closed = snapshot.shift?.closedAt != null;
  const blocking = Math.max(snapshot.shift?.unresolvedCount ?? 0, open.length);
  async function run(id: string, task: () => Promise<void>) {
    setPending(id);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие');
      throw cause;
    } finally {
      setPending(null);
    }
  }
  return (
    <main className="min-h-0 flex-1 overflow-auto px-4 pb-4">
      <section className="mx-auto max-w-5xl rounded-3xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Алерты</h1>
            <p className="mt-2 text-sm text-muted">
              Проблемы, требующие решения диспетчера. Прочтение не закрывает алерт.
            </p>
            <p className="mt-1 text-sm text-muted">
              {formatDayTitle(snapshot.workDate)} · Нерешённых: {open.length}
            </p>
          </div>
          <div className="max-w-xs">
            <button
              type="button"
              disabled={
                writesDisabled || pending !== null || closed || blocking > 0 || !snapshot.shift
              }
              onClick={() =>
                void run('close', () => {
                  if (closeOperation.current.date !== snapshot.workDate)
                    closeOperation.current = { date: snapshot.workDate, id: crypto.randomUUID() };
                  return onCloseShift(snapshot.workDate, closeOperation.current.id);
                }).catch((cause: unknown) => {
                  if (
                    cause instanceof DashboardApiError &&
                    cause.status >= 400 &&
                    cause.status < 500
                  ) {
                    closeOperation.current = { date: snapshot.workDate, id: crypto.randomUUID() };
                  }
                })
              }
              className="rounded-full bg-bee px-5 py-3 text-sm font-semibold disabled:opacity-50"
            >
              {closed ? 'Смена закрыта' : pending === 'close' ? 'Закрываем…' : 'Закрыть смену'}
            </button>
            <p className="mt-2 text-xs text-muted">
              {blocking > 0
                ? `Сначала решите все алерты смены (${blocking}).`
                : 'Сервер повторно проверит алерты перед закрытием.'}
            </p>
          </div>
        </div>
        {writesDisabled && (
          <p className="mt-4 rounded-xl bg-canvas p-3 text-sm text-muted">
            Режим просмотра. Для решений требуется подключение к рабочему серверу.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 rounded-xl border border-line p-3 text-sm">
            {error}
          </p>
        )}
        <nav className="mt-6 flex flex-wrap gap-2" aria-label="Разделы алертов">
          {(['open', 'history', 'notices'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={section === tab}
              onClick={() => setSection(tab)}
              className={`rounded-full px-4 py-2 text-sm ${section === tab ? 'bg-ink text-white' : 'bg-canvas text-muted'}`}
            >
              {tab === 'open'
                ? `Требуют решения · ${open.length}`
                : tab === 'history'
                  ? 'История решений'
                  : 'Уведомления'}
            </button>
          ))}
        </nav>
        <div className="mt-5 space-y-4">
          {selected.length === 0 && (
            <p className="rounded-2xl border border-dashed border-line p-8 text-center text-sm text-muted">
              {section === 'open'
                ? 'Нет алертов, требующих решения.'
                : section === 'history'
                  ? 'Решённых алертов пока нет.'
                  : 'Уведомлений пока нет.'}
            </p>
          )}
          {selected.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              snapshot={snapshot}
              now={now}
              disabled={writesDisabled || pending !== null}
              pending={pending === alert.id}
              onResolve={(input) => run(alert.id, () => onResolve(alert.id, input))}
              onSeen={() => run(alert.id, () => onSeen(alert.id)).catch(() => undefined)}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function AlertCard({
  alert,
  snapshot,
  now,
  disabled,
  pending,
  onResolve,
  onSeen,
}: {
  readonly alert: AlertView;
  readonly snapshot: DashboardSnapshot;
  readonly now: number;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onResolve: (input: AlertResolutionInput) => Promise<void>;
  readonly onSeen: () => Promise<void>;
}) {
  const request = snapshot.requests.find((item) => alert.requestIds.includes(item.id));
  const additionalEngineers = snapshot.engineers.filter(
    (engineer) =>
      !alert.engineerIds.includes(engineer.id) &&
      engineer.day?.availability === 'offline' &&
      (!request || engineer.skills.includes(request.requiredSkill)) &&
      (!request?.region || engineer.region === request.region),
  );
  const [action, setAction] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [engineerId, setEngineerId] = useState('');
  const [start, setStart] = useState(request ? alertWindowInput(request.windowStartAt) : '');
  const [end, setEnd] = useState(request ? alertWindowInput(request.windowEndAt) : '');
  const [validationError, setValidationError] = useState<string | null>(null);
  const retry = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const notice = alert.kind === 'notice';
  const open = isOpenAlert(alert);
  const elapsed = alertDecisionSeconds(alert, now);
  async function submit() {
    setValidationError(null);
    try {
      const input = {
        action,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(action === 'extend' ? { minutes: alert.code === 'shift_no_show' ? 15 : minutes } : {}),
        ...(action === 'add_engineer' ? { engineerId } : {}),
        ...(action === 'move_window'
          ? { windowStartAt: alertWindowSeconds(start), windowEndAt: alertWindowSeconds(end) }
          : {}),
      };
      if (
        input.windowStartAt !== undefined &&
        input.windowEndAt !== undefined &&
        input.windowEndAt <= input.windowStartAt
      )
        throw new Error('Конец окна должен быть позже начала');
      const fingerprint = JSON.stringify(input);
      if (retry.current?.fingerprint !== fingerprint)
        retry.current = { fingerprint, operationId: crypto.randomUUID() };
      await onResolve({ ...input, operationId: retry.current.operationId });
    } catch (cause) {
      if (cause instanceof DashboardApiError && cause.status >= 400 && cause.status < 500)
        retry.current = null;
      setValidationError(cause instanceof Error ? cause.message : 'Проверьте данные');
    }
  }
  return (
    <article
      className={`rounded-2xl border border-line border-l-4 p-5 ${notice ? 'border-l-line bg-canvas' : 'border-l-bee'}`}
    >
      <div className="flex flex-wrap justify-between gap-2">
        <h2 className="font-semibold">{alertTitle(alert.code)}</h2>
        <span className="text-xs text-muted">
          {alert.workDate ?? snapshot.workDate} · {formatClock(alert.createdAt)}
        </span>
      </div>
      {alert.engineerIds.map((id) => (
        <p key={id} className="mt-1 text-sm">
          {snapshot.engineers.find((item) => item.id === id)?.displayName ?? id}
        </p>
      ))}
      {alert.requestIds.map((id) => (
        <p key={id} className="mt-1 text-sm text-muted">
          {snapshot.requests.find((item) => item.id === id)?.addressText ?? `Заявка ${id}`}
        </p>
      ))}
      {alert.reasons.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
          {[...new Set(alert.reasons)].map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      )}
      {!notice && (
        <p className="mt-3 text-xs text-muted">
          {elapsed > 0
            ? `Время решения после первых 3 минут: ${Math.floor(elapsed / 60)} мин ${elapsed % 60} с`
            : 'Первые 3 минуты не учитываются во времени решения.'}
        </p>
      )}
      {!open && !notice && (
        <p className="mt-3 text-sm">
          {alert.resolutionAction === 'superseded'
            ? 'Проблема больше не актуальна'
            : `Решено: ${ALERT_ACTION_LABELS[alert.resolutionAction ?? ''] ?? alert.resolutionAction ?? 'Закрыто системой'}`}
          {alert.resolutionReason ? ` · ${alert.resolutionReason}` : ''}
        </p>
      )}
      {notice &&
        (alert.seenAt === null ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onSeen()}
            className="mt-4 rounded-full border border-line bg-white px-4 py-2 text-sm disabled:opacity-50"
          >
            {pending ? 'Сохраняем…' : 'Прочитано'}
          </button>
        ) : (
          <p className="mt-3 text-xs text-muted">Прочитано</p>
        ))}
      {open && (
        <>
          {alert.resolutionAction === 'restore_auto' && (
            <p className="mt-3 text-sm text-muted">
              Ожидаем применения актуального автоматического плана. До подтверждения сервера алерт
              остаётся открытым.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {(alert.actions ?? []).map((value) => (
              <button
                type="button"
                key={value}
                disabled={disabled || !ALERT_ACTION_LABELS[value]}
                aria-pressed={action === value}
                onClick={() => {
                  setAction(value);
                  setValidationError(null);
                }}
                className={`rounded-full border border-line px-4 py-2 text-sm disabled:opacity-50 ${action === value ? 'bg-bee text-ink' : 'bg-white'}`}
              >
                {value === 'extend' && alert.code === 'shift_no_show'
                  ? 'Дать ещё 15 мин.'
                  : (ALERT_ACTION_LABELS[value] ?? value)}
              </button>
            ))}
            <button
              type="button"
              disabled
              title="Выбор варианта с AI появится позже"
              className="rounded-full border border-line px-4 py-2 text-sm opacity-40"
            >
              Решить с AI · скоро
            </button>
          </div>
          {action && (
            <form
              className="mt-4 space-y-3 rounded-xl bg-canvas p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {action === 'reschedule' && (
                <p className="text-sm text-muted">
                  Окно заявки будет перенесено на следующий день с сохранением времени.
                </p>
              )}
              {action === 'restore_auto' && (
                <p className="text-sm text-muted">
                  Будет восстановлен доступный автоматический вариант. Сервер проверит актуальность
                  плана.
                </p>
              )}
              {(action === 'message' || action === 'message_remove') && (
                <p className="text-sm text-muted">
                  Инженеру будет отправлено письмо на привязанную почту.
                </p>
              )}
              {action === 'move_window' && (
                <div className="flex flex-wrap gap-3">
                  <label className="text-sm">
                    Начало окна (Москва)
                    <input
                      required
                      type="datetime-local"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                      className="mt-1 block rounded-lg border border-line bg-white p-2"
                    />
                  </label>
                  <label className="text-sm">
                    Конец окна (Москва)
                    <input
                      required
                      type="datetime-local"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      className="mt-1 block rounded-lg border border-line bg-white p-2"
                    />
                  </label>
                </div>
              )}
              {action === 'add_engineer' && (
                <label className="block text-sm">
                  Дополнительный инженер
                  <select
                    required
                    value={engineerId}
                    onChange={(e) => setEngineerId(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-line bg-white p-2"
                  >
                    <option value="">Выберите инженера</option>
                    {additionalEngineers.map((engineer) => (
                      <option key={engineer.id} value={engineer.id}>
                        {engineer.displayName}
                      </option>
                    ))}
                  </select>
                  {additionalEngineers.length === 0 && (
                    <span className="mt-2 block text-muted">
                      Нет подходящих инженеров вне линии. Добавьте профиль или настройте смену во
                      вкладке «Инженеры».
                    </span>
                  )}
                </label>
              )}
              {action === 'extend' && alert.code !== 'shift_no_show' && (
                <label className="block text-sm">
                  Дополнительное время, мин.
                  <input
                    required
                    type="number"
                    min={1}
                    max={240}
                    step={1}
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.valueAsNumber)}
                    className="ml-3 w-24 rounded-lg border border-line bg-white p-2"
                  />
                </label>
              )}
              <label className="block text-sm">
                {action === 'keep_manual' ? 'Причина (обязательно)' : 'Комментарий (необязательно)'}
                <textarea
                  required={action === 'keep_manual'}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="mt-1 block w-full rounded-lg border border-line bg-white p-2"
                />
              </label>
              {validationError && (
                <p role="alert" className="text-sm">
                  {validationError}
                </p>
              )}
              <button
                type="submit"
                disabled={disabled || (action === 'keep_manual' && !reason.trim())}
                className="rounded-full bg-ink px-5 py-2 text-sm text-white disabled:opacity-50"
              >
                {pending ? 'Применяем…' : 'Применить решение'}
              </button>
            </form>
          )}
        </>
      )}
    </article>
  );
}
