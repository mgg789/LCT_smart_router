import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardApiError } from '../api/client';
import {
  fetchManualHistory,
  type ManualChange,
  type ManualHistory,
  type ManualPreview,
  manualExpectation,
  type PlanExpectation,
  previewManualChange,
} from '../api/manual';
import type { DashboardSnapshot } from '../api/types';
import { formatClock } from '../lib/time';
import { ModalLayer, ModalScrim } from './modalLayer';
import { shortRequestId } from './requestsTable';

const button =
  'rounded-[16px] bg-figma-bee px-[18px] py-[10px] font-semibold text-figma-ink disabled:opacity-45';
const field =
  'w-full rounded-[12px] border border-figma-dim/30 bg-white px-[12px] py-[10px] text-figma-ink';
const warningLabels: Record<string, string> = {
  SKILL_MISMATCH: 'Не хватает навыка',
  TRANSPORT_MISMATCH: 'Не подходит транспорт',
  REGION_MISMATCH: 'Другой регион',
  ENGINEER_UNAVAILABLE: 'Инженер недоступен или смена не задана',
  WINDOW_CONFLICT: 'Нарушается окно начала работ даже без учёта дороги',
  SHIFT_CONFLICT: 'Работы выходят за границы смены даже без учёта дороги',
};

/** One-gesture editor with server preview, captured versions and durable history. */
export function ManualPlanDialog({
  snapshot,
  token,
  action: initialAction,
  initialChange,
  engineerId,
  motionOn,
  onMode,
  onApply,
  onRefresh,
  onClose,
}: {
  snapshot: DashboardSnapshot;
  token: string;
  action: 'manual' | 'auto';
  initialChange?: ManualChange;
  engineerId?: string | null;
  motionOn: boolean;
  onMode: (mode: 'auto' | 'manual', expected: PlanExpectation, reason?: string) => Promise<void>;
  onApply: (change: ManualChange, expected: PlanExpectation, operationId: string) => Promise<void>;
  onRefresh: () => Promise<DashboardSnapshot | null>;
  onClose: () => void;
}) {
  const [action, setAction] = useState(initialAction);
  const [base, setBase] = useState(snapshot);
  const [reason, setReason] = useState('');
  const [selectedEngineer, setSelectedEngineer] = useState(
    initialChange?.engineerId ?? engineerId ?? snapshot.engineers[0]?.id ?? '',
  );
  const [selectedRequest, setSelectedRequest] = useState(
    initialChange?.kind === 'reassign' ? initialChange.requestId : '',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState<{
    change: ManualChange;
    value: ManualPreview;
    operationId: string;
  } | null>(null);
  const [history, setHistory] = useState<ManualHistory>([]);
  const dragged = useRef<string | null>(null);
  const initialShown = useRef(false);
  const mustEnter = base.plan.mode !== 'manual' && action === 'manual';
  const expected = manualExpectation(base.plan);
  const name = (id: string) => base.engineers.find((e) => e.id === id)?.displayName ?? id;
  const requestName = (id: string) =>
    base.requests.find((r) => r.id === id)?.addressText ?? shortRequestId(id);
  const editable = base.requests.filter(
    (r) => r.lifecycle === 'submitted' && r.startedAt === null && !r.assumedCompletedAt,
  );
  const route = base.plan.plan?.routes.find((r) => r.engineerId === selectedEngineer);
  const queue =
    route?.stops.flatMap((s) =>
      s.requestId && editable.some((r) => r.id === s.requestId) ? [s.requestId] : [],
    ) ?? [];

  const fail = useCallback((cause: unknown) => {
    const stale = cause instanceof DashboardApiError && cause.status === 409;
    setConflict(stale);
    setError(
      stale
        ? 'План или состояние заявки изменились. Обновите данные и повторно проверьте действие. Чужая правка сохранена.'
        : cause instanceof Error
          ? cause.message
          : 'Не удалось подтвердить действие',
    );
  }, []);
  const reload = async () => {
    const next = await onRefresh();
    if (!next) throw new Error('Не удалось получить актуальный план');
    setBase(next);
    setPreview(null);
    setError(null);
    setConflict(false);
    const result = await fetchManualHistory(token);
    setHistory(result.entries);
  };
  const inspect = useCallback(
    async (change: ManualChange) => {
      if (pending) return;
      setPending(true);
      setError(null);
      try {
        const value = await previewManualChange(token, change, manualExpectation(base.plan));
        setPreview({ change, value, operationId: crypto.randomUUID() });
      } catch (cause) {
        fail(cause);
      } finally {
        setPending(false);
      }
    },
    [base.plan, pending, token, fail],
  );
  useEffect(() => {
    let active = true;
    void fetchManualHistory(token)
      .then((value) => {
        if (active) setHistory(value.entries);
      })
      .catch((cause) => {
        if (active) fail(cause);
      });
    return () => {
      active = false;
    };
  }, [token, fail]);
  useEffect(() => {
    if (!pending && !mustEnter && action === 'manual' && initialChange && !initialShown.current) {
      initialShown.current = true;
      void inspect(initialChange);
    }
  }, [pending, mustEnter, initialChange, action, inspect]);
  const switchMode = async () => {
    setPending(true);
    setError(null);
    try {
      await onMode(action, expected, action === 'manual' ? reason.trim() : undefined);
      if (action === 'auto') onClose();
      else await reload();
    } catch (cause) {
      fail(cause);
    } finally {
      setPending(false);
    }
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= queue.length || from === to) return;
    const order = [...queue];
    const [id] = order.splice(from, 1);
    if (!id) return;
    order.splice(to, 0, id);
    void inspect({ kind: 'reorder', engineerId: selectedEngineer, requestIds: order });
  };

  return (
    <ModalLayer open motionOn={motionOn} zClass="z-[110]">
      <ModalScrim label="Закрыть ручное управление" disabled={pending} onClose={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-title"
        className="relative max-h-[900px] w-[820px] overflow-y-auto rounded-[20px] bg-white p-[30px] text-figma-ink"
      >
        <div className="flex items-center justify-between gap-[16px]">
          <h2 id="manual-title" className="figma-text text-[28px] font-extrabold">
            {action === 'auto'
              ? 'Вернуть AUTO'
              : mustEnter
                ? 'Перейти в MANUAL'
                : 'Ручное управление'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Закрыть"
            className={button}
          >
            ×
          </button>
        </div>
        {base.plan.mode === 'manual' && action === 'manual' ? (
          <button
            type="button"
            className={`${button} mt-[12px]`}
            disabled={pending}
            onClick={() => {
              setPreview(null);
              setAction('auto');
            }}
          >
            Вернуть AUTO…
          </button>
        ) : null}
        <p className="my-[16px] text-[16px] text-figma-dim">
          Ревизия плана {expected.expectedPlanRevision}.{' '}
          {mustEnter
            ? 'Результаты Router перестанут менять план. Причина перехода сохранится в журнале.'
            : action === 'auto'
              ? 'Актуальный автоматический расчёт заменит будущие ручные назначения. До его применения текущий план останется видимым. Факты выполнения сохранятся.'
              : 'Назначения и порядок сохраняются сразу после подтверждения одного действия. Уже начатые и завершённые работы защищены.'}
        </p>
        {error ? (
          <p role="alert" className="my-[12px] rounded-[12px] bg-figma-soft p-[12px]">
            {error}
          </p>
        ) : null}
        {!base.routerSettings ? (
          <p role="status" className="my-[12px] rounded-[12px] bg-figma-soft p-[12px]">
            Настройки Router временно недоступны. Ручной план и факты берутся с сервера; ручные
            действия доступны.
          </p>
        ) : null}
        {conflict ? (
          <button
            className={button}
            type="button"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void reload()
                .catch(fail)
                .finally(() => setPending(false));
            }}
          >
            Обновить план
          </button>
        ) : null}
        {mustEnter || action === 'auto' ? (
          <>
            {mustEnter ? (
              <label className="block text-[18px]">
                Причина перехода
                <textarea
                  className={`${field} mt-[8px] min-h-[100px]`}
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Например: согласованы изменения с клиентом"
                />
              </label>
            ) : null}
            <div className="mt-[20px] flex gap-[12px]">
              <button
                type="button"
                className={button}
                disabled={pending || conflict || (mustEnter && !reason.trim())}
                onClick={() => void switchMode()}
              >
                {pending ? 'Сохраняем…' : mustEnter ? 'Включить MANUAL' : 'Подтвердить AUTO'}
              </button>
              <button type="button" className={button} disabled={pending} onClick={onClose}>
                Отмена
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-[16px] rounded-[12px] bg-figma-soft p-[12px]">
              Время прибытия, расстояние и длительность дороги после ручной правки не пересчитаны.
              Проверка окон ниже — нижняя граница без дороги, не новый ETA.
            </p>
            {preview ? (
              <div className="space-y-[12px]" data-testid="manual-preview">
                <h3 className="text-[20px] font-semibold">Проверка изменения</h3>
                <p>
                  {preview.change.kind === 'reassign'
                    ? `${requestName(preview.change.requestId)} → ${name(preview.change.engineerId)}`
                    : `Новый порядок — ${name(preview.change.engineerId)}`}
                </p>
                {preview.value.queues
                  .filter((q) => q.engineerId === preview.change.engineerId)
                  .map((q) => (
                    <ol
                      key={q.engineerId}
                      className="list-inside list-decimal rounded-[12px] bg-figma-soft p-[12px]"
                    >
                      {q.requestIds.map((id) => (
                        <li key={id}>{requestName(id)}</li>
                      ))}
                    </ol>
                  ))}
                <ul className="space-y-[6px]">
                  {preview.value.warnings
                    .filter((w) => w.code !== 'TIMING_UNVERIFIED')
                    .map((w) => (
                      <li key={`${w.engineerId}-${w.requestId}-${w.code}`}>
                        ⚠ {warningLabels[w.code] ?? w.code}: {requestName(w.requestId)} ·{' '}
                        {name(w.engineerId)}
                      </li>
                    ))}
                </ul>
                <div className="flex gap-[12px]">
                  <button
                    type="button"
                    className={button}
                    disabled={pending || conflict}
                    onClick={() => {
                      setPending(true);
                      setError(null);
                      void onApply(preview.change, expected, preview.operationId)
                        .then(reload)
                        .catch(fail)
                        .finally(() => setPending(false));
                    }}
                  >
                    {pending ? 'Сохраняем…' : 'Сохранить ручное изменение'}
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={pending}
                    onClick={() => setPreview(null)}
                  >
                    Отмена изменения
                  </button>
                </div>
              </div>
            ) : (
              <>
                <label className="block">
                  Инженер
                  <select
                    aria-label="Инженер"
                    className={`${field} mt-[8px]`}
                    value={selectedEngineer}
                    onChange={(e) => setSelectedEngineer(e.target.value)}
                    disabled={pending}
                  >
                    {base.engineers.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="my-[12px] text-figma-dim">
                  Перетащите заявку или используйте стрелки. Перед записью появится проверка
                  последствий.
                </p>
                <ol className="space-y-[8px]" aria-label="Очередь неначатых заявок">
                  {queue.map((id, index) => (
                    <li
                      key={id}
                      draggable={!pending && !conflict}
                      onDragStart={(event) => {
                        dragged.current = id;
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', id);
                      }}
                      onDragEnd={() => {
                        dragged.current = null;
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = queue.indexOf(dragged.current ?? '');
                        if (from >= 0) move(from, index);
                        dragged.current = null;
                      }}
                      className="flex items-center gap-[12px] rounded-[12px] bg-figma-soft p-[12px]"
                    >
                      <span className="flex-1">
                        {index + 1}. {requestName(id)}
                      </span>
                      <button
                        type="button"
                        className={button}
                        aria-label={`Поднять ${shortRequestId(id)}`}
                        disabled={pending || conflict || index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={button}
                        aria-label={`Опустить ${shortRequestId(id)}`}
                        disabled={pending || conflict || index === queue.length - 1}
                        onClick={() => move(index, index + 1)}
                      >
                        ↓
                      </button>
                    </li>
                  ))}
                </ol>
                {queue.length === 0 ? (
                  <p className="my-[12px]">Нет заявок, которые можно переставить.</p>
                ) : null}
                <label className="mt-[20px] block">
                  Назначить заявку этому инженеру
                  <select
                    aria-label="Назначить заявку этому инженеру"
                    className={`${field} mt-[8px]`}
                    value={selectedRequest}
                    onChange={(e) => setSelectedRequest(e.target.value)}
                    disabled={pending}
                  >
                    <option value="">Выберите заявку</option>
                    {editable.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.addressText}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={`${button} mt-[12px]`}
                  disabled={pending || conflict || !selectedRequest || !selectedEngineer}
                  onClick={() =>
                    void inspect({
                      kind: 'reassign',
                      requestId: selectedRequest,
                      engineerId: selectedEngineer,
                    })
                  }
                >
                  Проверить переназначение
                </button>
              </>
            )}
          </>
        )}
        <details className="mt-[24px] border-t border-figma-dim/20 pt-[16px]">
          <summary className="cursor-pointer font-semibold">
            Журнал ручного управления ({history.length})
          </summary>
          {history.length === 0 ? (
            <p className="mt-[12px]">Записей пока нет.</p>
          ) : (
            <ol className="mt-[12px] space-y-[12px]">
              {history.map((entry) => (
                <li key={entry.id}>
                  <div>
                    {formatClock(entry.at)} ·{' '}
                    {entry.details.change
                      ? entry.details.change.kind === 'reorder'
                        ? `Порядок: ${name(entry.details.change.engineerId)}`
                        : `${requestName(entry.details.change.requestId)} → ${name(entry.details.change.engineerId)}`
                      : `${entry.details.from?.toUpperCase()} → ${entry.details.to?.toUpperCase()}`}
                  </div>
                  {entry.details.reason ? <p>{entry.details.reason}</p> : null}
                  <small className="text-figma-dim">
                    Пользователь {entry.actorId} · ревизия {entry.details.sourcePlanRevision ?? '—'}
                    {entry.details.planRevision ? ` → ${entry.details.planRevision}` : ''}
                  </small>
                </li>
              ))}
            </ol>
          )}
        </details>
      </section>
    </ModalLayer>
  );
}
