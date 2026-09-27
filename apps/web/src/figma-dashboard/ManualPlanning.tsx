import { Reorder } from 'framer-motion';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { setDispatchMode } from '../api/client';
import {
  deleteManualDecision,
  loadManualState,
  type ManualDecisionInput,
  type ManualState,
  saveManualDecision,
  saveManualPriorities,
} from '../api/manual';
import type { DashboardSnapshot } from '../api/types';
import { formatClock } from '../lib/time';
import { ModalLayer, ModalScrim } from './modalLayer';

const FIELD =
  'h-[40px] min-w-0 rounded-[12px] border border-figma-ink/20 bg-white px-[12px] text-[16px] text-figma-ink';
const BUTTON =
  'rounded-[16px] bg-figma-bee px-[20px] py-[12px] font-semibold text-figma-ink disabled:opacity-40';
const LABELS = { assignment: 'Исполнитель', window: 'Окно заявки', lunch: 'Обед', shift: 'Смена' };
type Editor = {
  kind: 'window' | 'lunch' | 'shift';
  targetId: string;
  startAt: number;
  endAt: number;
};
type Context = {
  snapshot: DashboardSnapshot | null;
  state: ManualState | null;
  active: boolean;
  busy: boolean;
  save: (input: ManualDecisionInput) => Promise<void>;
  edit: (editor: Editor) => void;
};
const ManualContext = createContext<Context | null>(null);
/** Opens the shared manual mode or priorities dialog from dashboard menu controls. */
export function openManualPlanning(panel: 'mode' | 'priorities'): void {
  window.dispatchEvent(new CustomEvent('manual-planning-open', { detail: panel }));
}
/** Owns versioned manual state, confirmation dialogs and conflict review across dashboard tabs. */
export function ManualPlanningProvider({
  token,
  snapshot,
  refresh,
  children,
}: {
  token: string | null;
  snapshot: DashboardSnapshot | null;
  refresh: () => Promise<unknown>;
  children: ReactNode;
}) {
  const [state, setState] = useState<ManualState | null>(null);
  const [panel, setPanel] = useState<'mode' | 'priorities' | 'intro' | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ordered, setOrdered] = useState<string[]>([]);
  const orderDirty = useRef(false);
  const seenConflict = useRef<string | null>(null);
  const active = snapshot?.plan.mode === 'manual';
  useEffect(() => {
    const open = (event: Event) => {
      const requested = (event as CustomEvent<'mode' | 'priorities' | 'request-manual'>).detail;
      if (requested === 'request-manual' && active) return;
      setEditor(null);
      setPanel(requested === 'request-manual' ? 'mode' : requested);
      setError(null);
    };
    window.addEventListener('manual-planning-open', open);
    return () => window.removeEventListener('manual-planning-open', open);
  }, [active]);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const read = async () => {
      try {
        const next = await loadManualState(token);
        if (cancelled) return;
        setState((current) => (current && current.version > next.version ? current : next));
        const key = `${next.version}:${next.resolution?.inputHash}`;
        if (active && next.needsReview && seenConflict.current !== key) {
          seenConflict.current = key;
          setPanel((current) => (current === 'intro' ? current : 'priorities'));
        }
      } catch {
        /* The normal dashboard connection indicator covers polling failures. */
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token, active]);
  const orderedVersion = useRef<number | null>(null);
  useEffect(() => {
    if (!state || orderedVersion.current === state.version) return;
    orderedVersion.current = state.version;
    const serverOrder = [...state.decisions]
      .sort((a, b) => a.priority - b.priority)
      .map((item) => item.id);
    setOrdered((current) =>
      orderDirty.current
        ? [
            ...current.filter((id) => serverOrder.includes(id)),
            ...serverOrder.filter((id) => !current.includes(id)),
          ]
        : serverOrder,
    );
  }, [state]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить решение');
      setPanel((current) => current ?? 'priorities');
      if (token) setState(await loadManualState(token).catch(() => state));
    } finally {
      setBusy(false);
    }
  };
  const save = async (input: ManualDecisionInput) => {
    if (!token || !state || !active || busy) return;
    await perform(async () => {
      setState(await saveManualDecision(token, state.version, input));
      setEditor(null);
    });
  };
  const title = editor
    ? LABELS[editor.kind]
    : panel === 'mode'
      ? active
        ? 'Вернуться в автоматический режим?'
        : 'Ручное управление'
      : panel === 'intro'
        ? 'Теперь вам доступно ручное управление'
        : state?.needsReview
          ? 'Конфликт приоритетов'
          : 'Приоритеты решений';
  return (
    <ManualContext.Provider value={{ snapshot, state, active, busy, save, edit: setEditor }}>
      {children}
      <ModalLayer open={panel !== null || editor !== null} motionOn>
        <ModalScrim
          label="Закрыть ручное управление"
          disabled={busy || panel === 'intro'}
          onClose={() => {
            setPanel(null);
            setEditor(null);
          }}
        />
        <section
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="relative max-h-[85vh] w-[680px] overflow-y-auto rounded-[24px] bg-white p-[28px] text-figma-ink"
        >
          <h2 className="mb-[18px] text-[26px] font-bold">{title}</h2>
          {panel === 'mode' && !editor ? (
            <>
              <p className="mb-[16px] leading-relaxed">
                {active
                  ? 'Все ручные решения будут удалены. Исходные условия заявок, обедов и смен восстановятся, а автоматический расчёт заново построит план. Фактическое выполнение и начатые работы сохранятся.'
                  : 'Ручной режим может снизить эффективность плана и оставить часть заявок без назначения. Вы задаёте обязательные решения, а алгоритм продолжает строить маршруты с их учётом. Новые решения получают одинаковый наивысший приоритет. Если решения несовместимы, расставьте их по важности. Начатые работы и фактические отметки сохраняются.'}
              </p>
              {!active ? (
                <label className="block">
                  Причина перехода в ручной режим
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={1000}
                    className={`${FIELD} mt-[8px] h-[90px] w-full py-[10px]`}
                    placeholder="Почему требуется вмешательство диспетчера"
                  />
                </label>
              ) : null}
              <button
                type="button"
                disabled={busy || (!active && !reason.trim())}
                className={`${BUTTON} mt-[16px]`}
                onClick={() => {
                  if (!token) return;
                  void perform(async () => {
                    await setDispatchMode(
                      token,
                      active ? 'auto' : 'manual',
                      active ? undefined : reason.trim(),
                    );
                    let showIntroduction = false;
                    if (!active) {
                      try {
                        showIntroduction =
                          localStorage.getItem('navix.manual-introduction.v1') !== 'seen';
                      } catch {
                        showIntroduction = true;
                      }
                    }
                    setPanel(showIntroduction ? 'intro' : null);
                    setState(await loadManualState(token));
                  });
                }}
              >
                {active ? 'Включить автоматический режим' : 'Продолжить в ручном режиме'}
              </button>
            </>
          ) : null}
          {panel === 'intro' && !editor ? <ManualFeaturePresentation /> : null}
          {panel === 'priorities' && !editor ? (
            <>
              <p className="mb-[16px] text-figma-muted">
                Перетащите важнейшие решения вверх. Красной рамкой отмечены несовместимые решения. В
                текущем расчёте не удалось совместить их — это не доказывает, что решения
                невозможны. Применение порядка запускает новый расчёт.
              </p>
              {ordered.length === 0 ? (
                <p>Ручных решений пока нет.</p>
              ) : (
                <Reorder.Group
                  axis="y"
                  values={ordered}
                  onReorder={(next) => {
                    orderDirty.current = true;
                    setOrdered(next);
                  }}
                  className="space-y-[10px]"
                >
                  {ordered.map((id, index) => {
                    const item = state?.decisions.find((row) => row.id === id);
                    if (!item) return null;
                    const target =
                      snapshot?.requests.find((row) => row.id === item.targetId)?.addressText ??
                      snapshot?.engineers.find((row) => row.id === item.targetId)?.displayName ??
                      item.targetId;
                    return (
                      <Reorder.Item
                        key={id}
                        value={id}
                        dragListener={!busy}
                        className={`rounded-[16px] border-2 bg-figma-canvas p-[16px] ${state?.resolution?.conflictIds.includes(id) ? 'border-figma-danger' : 'border-transparent'}`}
                      >
                        <div className="flex items-center gap-[12px]">
                          <span aria-hidden>↕</span>
                          <div className="min-w-0 flex-1">
                            <strong>
                              {LABELS[item.kind]} · {target}
                            </strong>
                            <p>
                              {item.kind === 'assignment'
                                ? item.engineerId
                                  ? (snapshot?.engineers.find((row) => row.id === item.engineerId)
                                      ?.displayName ?? item.engineerId)
                                  : 'Без назначения'
                                : `${formatClock(item.startAt ?? 0)}–${formatClock(item.endAt ?? 0)}`}
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={busy || index === 0}
                            aria-label="Повысить приоритет"
                            onClick={() =>
                              setOrdered((rows) => {
                                orderDirty.current = true;
                                const next = [...rows];
                                const previous = next[index - 1];
                                const current = next[index];
                                if (previous !== undefined && current !== undefined) {
                                  next[index - 1] = current;
                                  next[index] = previous;
                                }
                                return next;
                              })
                            }
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            aria-label="Удалить решение"
                            onClick={() => {
                              if (token && state)
                                void perform(async () =>
                                  setState(await deleteManualDecision(token, state.version, id)),
                                );
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </Reorder.Item>
                    );
                  })}
                </Reorder.Group>
              )}
              <button
                type="button"
                disabled={busy || !ordered.length || !active}
                className={`${BUTTON} mt-[18px]`}
                onClick={() => {
                  if (token && state)
                    void perform(async () => {
                      const next = await saveManualPriorities(token, state.version, ordered);
                      orderDirty.current = false;
                      setState(next);
                      setPanel(null);
                    });
                }}
              >
                Применить порядок
              </button>
            </>
          ) : null}
          {editor ? (
            <TimeEditor
              key={`${editor.kind}:${editor.targetId}`}
              editor={editor}
              busy={busy}
              nowAt={snapshot?.nowAt ?? 0}
              onSave={save}
            />
          ) : null}
          {error ? (
            <p role="alert" className="mt-[14px] text-figma-danger">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (panel === 'intro') {
                try {
                  localStorage.setItem('navix.manual-introduction.v1', 'seen');
                } catch {
                  /* Storage is optional. */
                }
              }
              setPanel(panel === 'intro' && state?.needsReview ? 'priorities' : null);
              setEditor(null);
            }}
            className="ml-[14px] mt-[18px] rounded-[16px] border border-figma-ink/30 px-[20px] py-[12px]"
          >
            {panel === 'intro' ? 'Понятно' : 'Назад'}
          </button>
        </section>
      </ModalLayer>
    </ManualContext.Provider>
  );
}

/** First-use overview shown only after manual mode has successfully been enabled. */
export function ManualFeaturePresentation() {
  return (
    <div className="space-y-[16px] leading-relaxed">
      <ul className="space-y-[12px]">
        <li className="flex items-start gap-[12px]">
          <img
            src="/figma/manual-assignment.svg"
            alt=""
            className="mt-[3px] size-[24px] shrink-0"
          />
          <span>
            <strong>Назначения.</strong> Выбирайте инженера на линии или оставляйте заявку без
            исполнителя в её панели.
          </span>
        </li>
        <li className="flex items-start gap-[12px]">
          <img src="/figma/manual-window.svg" alt="" className="mt-[3px] size-[24px] shrink-0" />
          <span>
            <strong>Окна заявок.</strong> Задавайте ручное окно рядом с исходным. Изменение требует
            подтверждения.
          </span>
        </li>
        <li className="flex items-start gap-[12px]">
          <img src="/figma/manual-lunch.svg" alt="" className="mt-[3px] size-[24px] shrink-0" />
          <span>
            <strong>Обеды.</strong> Нажмите будущий обед в маршруте инженера, чтобы изменить его
            время.
          </span>
        </li>
        <li className="flex items-start gap-[12px]">
          <img src="/figma/manual-shift.svg" alt="" className="mt-[3px] size-[24px] shrink-0" />
          <span>
            <strong>Смены.</strong> Редактируйте время смены в досье инженера. Выполненные действия
            не меняются.
          </span>
        </li>
      </ul>
      <p>
        Алгоритм продолжает перестраивать маршруты. Новые решения имеют одинаковый наивысший
        приоритет. Если текущий расчёт не смог совместить решения, откроется «Конфликт приоритетов»:
        перетащите важнейшие выше и примените порядок. Панель всегда доступна через «Приоритеты» в
        системном меню.
      </p>
    </div>
  );
}

function TimeEditor({
  editor,
  busy,
  nowAt,
  onSave,
}: {
  editor: Editor;
  busy: boolean;
  nowAt: number;
  onSave: (input: ManualDecisionInput) => Promise<void>;
}) {
  const [start, setStart] = useState(formatClock(editor.startAt));
  const [end, setEnd] = useState(formatClock(editor.endAt));
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(
    new Date(editor.startAt * 1000),
  );
  const startAt = Date.parse(`${date}T${start}:00+03:00`) / 1000;
  const endAt = Date.parse(`${date}T${end}:00+03:00`) / 1000;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ kind: editor.kind, targetId: editor.targetId, startAt, endAt });
      }}
    >
      <div className="flex gap-[16px]">
        <label>
          Начало
          <input
            aria-label="Начало"
            type="time"
            disabled={editor.kind === 'shift' && editor.startAt < nowAt}
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className={`${FIELD} block`}
          />
        </label>
        <label>
          Конец
          <input
            aria-label="Конец"
            type="time"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            className={`${FIELD} block`}
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={
          busy ||
          !Number.isFinite(startAt) ||
          !Number.isFinite(endAt) ||
          endAt <= startAt ||
          endAt <= nowAt ||
          (editor.kind !== 'shift' && startAt < nowAt)
        }
        className={`${BUTTON} mt-[18px]`}
      >
        Сохранить решение
      </button>
    </form>
  );
}

/** Inline manual assignment/window controls, suppressed for started or terminal requests. */
export function ManualRequestControls({ requestId }: { requestId: string }) {
  const manual = useContext(ManualContext);
  if (!manual?.active) return null;
  const request = manual.snapshot?.requests.find((item) => item.id === requestId);
  if (request?.lifecycle !== 'submitted' || request.startedAt !== null) return null;
  const assignment = manual.state?.decisions.find(
    (item) => item.kind === 'assignment' && item.targetId === requestId,
  );
  const window = manual.state?.decisions.find(
    (item) => item.kind === 'window' && item.targetId === requestId,
  );
  const assigned = manual.snapshot?.plan.plan?.routes.find((route) =>
    route.stops.some((stop) => stop.requestId === requestId),
  )?.engineerId;
  return (
    <div className="my-[16px] space-y-[10px] rounded-[16px] bg-white/10 p-[12px] text-white">
      <label className="block">
        Исполнитель
        <select
          aria-label="Ручной исполнитель"
          disabled={manual.busy || !manual.state}
          className={`${FIELD} mt-[6px] w-full`}
          value={assignment ? (assignment.engineerId ?? '') : (assigned ?? '')}
          onChange={(event) =>
            void manual.save({
              kind: 'assignment',
              targetId: requestId,
              engineerId: event.target.value || null,
            })
          }
        >
          <option value="">Нет исполнителя</option>
          {manual.snapshot?.engineers
            .filter((engineer) => engineer.day?.availability === 'online')
            .map((engineer) => (
              <option key={engineer.id} value={engineer.id}>
                {engineer.displayName}
              </option>
            ))}
        </select>
      </label>
      <p className="text-[14px]">
        Исходное окно: {formatClock(request.windowStartAt)}–{formatClock(request.windowEndAt)}
      </p>
      <button
        type="button"
        disabled={manual.busy || request.workCategory === 'emergency'}
        title={
          request.workCategory === 'emergency'
            ? 'Авария направляется первой свободной бригаде'
            : undefined
        }
        className={BUTTON}
        onClick={() =>
          manual.edit({
            kind: 'window',
            targetId: requestId,
            startAt: window?.startAt ?? request.windowStartAt,
            endAt: window?.endAt ?? request.windowEndAt,
          })
        }
      >
        {window
          ? `Ручное окно: ${formatClock(window.startAt ?? 0)}–${formatClock(window.endAt ?? 0)}`
          : 'Изменить окно'}
      </button>
    </div>
  );
}
/** Inline edit controls for future engineer lunch and shift boundaries. */
export function ManualEngineerControls({
  engineerId,
  kind = 'shift',
}: {
  engineerId: string;
  kind?: 'lunch' | 'shift';
}) {
  const manual = useContext(ManualContext);
  if (!manual?.active) return null;
  const day = manual.snapshot?.engineers.find((item) => item.id === engineerId)?.day;
  if (!day) return null;
  const lunch = manual.snapshot?.plan.plan?.routes
    .find((row) => row.engineerId === engineerId)
    ?.stops.find((stop) => stop.kind === 'lunch');
  const decision = manual.state?.decisions.find(
    (item) => item.kind === kind && item.targetId === engineerId,
  );
  const startAt =
    decision?.startAt ??
    (kind === 'shift' ? day.shiftStartAt : (lunch?.startAt ?? day.lunch.windowStartAt));
  const endAt =
    decision?.endAt ??
    (kind === 'shift' ? day.shiftEndAt : (lunch?.endAt ?? day.lunch.windowEndAt));
  if (
    startAt == null ||
    endAt == null ||
    endAt <= (manual.snapshot?.nowAt ?? 0) ||
    (kind === 'lunch' && (day.lunch.taken || day.lunch.startedAt !== null))
  )
    return null;
  return (
    <button
      type="button"
      disabled={manual.busy}
      className={`${BUTTON} my-[8px] text-[14px]`}
      onClick={() => manual.edit({ kind, targetId: engineerId, startAt, endAt })}
    >
      {kind === 'shift' ? 'Изменить смену' : 'Изменить обед'}
    </button>
  );
}

/** Returns a lunch edit handler only when the future lunch is still editable. */
export function useManualLunchEdit(engineerId: string): (() => void) | undefined {
  const manual = useContext(ManualContext);
  const engineer = manual?.snapshot?.engineers.find((item) => item.id === engineerId);
  const lunch = manual?.snapshot?.plan.plan?.routes
    .find((row) => row.engineerId === engineerId)
    ?.stops.find((stop) => stop.kind === 'lunch');
  if (
    !manual?.active ||
    !lunch ||
    engineer?.day?.lunch.taken ||
    engineer?.day?.lunch.startedAt != null ||
    lunch.startAt < (manual.snapshot?.nowAt ?? 0)
  )
    return undefined;
  return () =>
    manual.edit({
      kind: 'lunch',
      targetId: engineerId,
      startAt: lunch.startAt,
      endAt: lunch.endAt,
    });
}
