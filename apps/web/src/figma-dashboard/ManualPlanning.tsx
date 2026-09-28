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
import { t } from '../i18n';
import { formatClock } from '../lib/time';
import { ModalLayer, ModalScrim } from './modalLayer';

const FIELD =
  'h-[40px] min-w-0 rounded-[12px] border border-figma-ink/20 bg-white px-[12px] text-[16px] text-figma-ink';
const BUTTON =
  'rounded-[16px] bg-figma-bee px-[20px] py-[12px] font-semibold text-figma-ink disabled:opacity-40';
const LABELS = {
  assignment: t('figma-dashboard.ManualPlanning.037174d588'),
  window: t('figma-dashboard.ManualPlanning.a0d7e011c3'),
  lunch: t('figma-dashboard.ManualPlanning.69a29fbff8'),
  shift: t('figma-dashboard.ManualPlanning.9f6558c272'),
};
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
/**
 * Opens the shared manual mode or priorities dialog from dashboard menu controls.
 *
 * `resume` is the action the dispatcher was already performing when the gate appeared.
 * Without it their first «Назначить» was simply swallowed: the reassignment opened the
 * mode dialog, the confirmation and the introduction took the two clicks that followed,
 * and the request kept its old engineer with nothing on screen to say so — they had to
 * work out for themselves that the whole thing needed doing again.
 */
export function openManualPlanning(
  panel: 'mode' | 'priorities',
  resume?: () => void | Promise<void>,
): void {
  window.dispatchEvent(new CustomEvent('manual-planning-open', { detail: { panel, resume } }));
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
  /** The action the gate interrupted; run once manual mode is really on. */
  const resumeRef = useRef<(() => void | Promise<void>) | null>(null);
  const active = snapshot?.plan.mode === 'manual';
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (
        event as CustomEvent<
          | 'mode'
          | 'priorities'
          | 'request-manual'
          | { panel: 'mode' | 'priorities'; resume?: () => void | Promise<void> }
        >
      ).detail;
      const requested = typeof detail === 'string' ? detail : detail.panel;
      if (requested === 'request-manual' && active) return;
      resumeRef.current = typeof detail === 'string' ? null : (detail.resume ?? null);
      setEditor(null);
      setPanel(requested === 'request-manual' ? 'mode' : requested);
      setError(null);
      if (requested === 'priorities' && token) {
        void loadManualState(token)
          .then((next) => {
            setState((current) => (current && current.version > next.version ? current : next));
          })
          .catch(() => {
            /* Polling retries a failed refresh. */
          });
      }
    };
    window.addEventListener('manual-planning-open', open);
    return () => window.removeEventListener('manual-planning-open', open);
  }, [active, token]);
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
      setError(
        cause instanceof Error ? cause.message : t('figma-dashboard.ManualPlanning.fad71eebdb'),
      );
      setPanel((current) => current ?? 'priorities');
      if (token) setState(await loadManualState(token).catch(() => state));
    } finally {
      setBusy(false);
    }
  };
  /** Carries out the interrupted action once, whatever happens to the dialog next. */
  const runResume = async () => {
    const pending = resumeRef.current;
    resumeRef.current = null;
    if (pending) await pending();
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
        ? t('figma-dashboard.ManualPlanning.d86a7ceb6d')
        : t('figma-dashboard.ManualPlanning.31f5da9ced')
      : panel === 'intro'
        ? t('figma-dashboard.ManualPlanning.b9e4f1d6c1')
        : state?.needsReview
          ? t('figma-dashboard.ManualPlanning.ae8726f728')
          : t('figma-dashboard.ManualPlanning.ea80e4af49');
  return (
    <ManualContext.Provider value={{ snapshot, state, active, busy, save, edit: setEditor }}>
      {children}
      <ModalLayer open={panel !== null || editor !== null} motionOn>
        <ModalScrim
          label={t('figma-dashboard.ManualPlanning.73d239f9ad')}
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
                  ? t('figma-dashboard.ManualPlanning.8c3db87659')
                  : t('figma-dashboard.ManualPlanning.08dee4935b')}
              </p>
              {!active ? (
                <label className="block">
                  {t('figma-dashboard.ManualPlanning.ee62d851ca')}
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={1000}
                    className={`${FIELD} mt-[8px] h-[90px] w-full py-[10px]`}
                    placeholder={t('figma-dashboard.ManualPlanning.ee03d28228')}
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
                    if (!active) await runResume();
                  });
                }}
              >
                {active
                  ? t('figma-dashboard.ManualPlanning.4b9201608f')
                  : t('figma-dashboard.ManualPlanning.42d0a74285')}
              </button>
            </>
          ) : null}
          {panel === 'intro' && !editor ? <ManualFeaturePresentation /> : null}
          {panel === 'priorities' && !editor ? (
            <>
              <p className="mb-[16px] text-figma-muted">
                {t('figma-dashboard.ManualPlanning.6344221560')}
              </p>
              {ordered.length === 0 ? (
                <p>{t('figma-dashboard.ManualPlanning.9505ee1e7f')}</p>
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
                                  : t('figma-dashboard.ManualPlanning.6de28b421e')
                                : `${formatClock(item.startAt ?? 0)}–${formatClock(item.endAt ?? 0)}`}
                            </p>
                            {state?.resolution?.rejectedIds.includes(id) && (
                              <p className="text-figma-danger">
                                {t('figma-dashboard.ManualPlanning.6d1ecbeaef')}
                              </p>
                            )}
                          </div>
                          <button
                            type="button"
                            disabled={busy || index === 0}
                            aria-label={t('figma-dashboard.ManualPlanning.f20dfd9cb1')}
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
                            aria-label={t('figma-dashboard.ManualPlanning.fc8d6b8050')}
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
                {t('figma-dashboard.ManualPlanning.96d8588dc7')}
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
            {panel === 'intro'
              ? t('figma-dashboard.ManualPlanning.e2ce86b38f')
              : t('figma-dashboard.ManualPlanning.1a9fb1f3cf')}
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
            <strong>{t('figma-dashboard.ManualPlanning.643c7aa928')}</strong>
            {t('figma-dashboard.ManualPlanning.3d062943fd')}
          </span>
        </li>
        <li className="flex items-start gap-[12px]">
          <img src="/figma/manual-window.svg" alt="" className="mt-[3px] size-[24px] shrink-0" />
          <span>
            <strong>{t('figma-dashboard.ManualPlanning.df666a3d4d')}</strong>
            {t('figma-dashboard.ManualPlanning.047440bba7')}
          </span>
        </li>
        <li className="flex items-start gap-[12px]">
          <img src="/figma/manual-lunch.svg" alt="" className="mt-[3px] size-[24px] shrink-0" />
          <span>
            <strong>{t('figma-dashboard.ManualPlanning.34dbb755c4')}</strong>
            {t('figma-dashboard.ManualPlanning.bc544f46f4')}
          </span>
        </li>
        <li className="flex items-start gap-[12px]">
          <img src="/figma/manual-shift.svg" alt="" className="mt-[3px] size-[24px] shrink-0" />
          <span>
            <strong>{t('figma-dashboard.ManualPlanning.1e7ba85ac0')}</strong>
            {t('figma-dashboard.ManualPlanning.bb4264eb26')}
          </span>
        </li>
      </ul>
      <p>{t('figma-dashboard.ManualPlanning.94da197e0c')}</p>
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
          {t('figma-dashboard.ManualPlanning.4af5d2efad')}
          <input
            aria-label={t('figma-dashboard.ManualPlanning.4af5d2efad')}
            type="time"
            disabled={editor.kind === 'shift' && editor.startAt < nowAt}
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className={`${FIELD} block`}
          />
        </label>
        <label>
          {t('figma-dashboard.ManualPlanning.9e6f8f9f1f')}
          <input
            aria-label={t('figma-dashboard.ManualPlanning.9e6f8f9f1f')}
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
        {t('figma-dashboard.ManualPlanning.d0f76330e9')}
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
        {t('figma-dashboard.ManualPlanning.037174d588')}
        <select
          aria-label={t('figma-dashboard.ManualPlanning.431dabe260')}
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
          <option value="">{t('figma-dashboard.ManualPlanning.998a2d9df7')}</option>
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
        {t('figma-dashboard.ManualPlanning.1a86f242d7')}
        {formatClock(request.windowStartAt)}–{formatClock(request.windowEndAt)}
      </p>
      <button
        type="button"
        disabled={manual.busy || request.workCategory === 'emergency'}
        title={
          request.workCategory === 'emergency'
            ? t('figma-dashboard.ManualPlanning.e58f2e7a8c')
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
          ? t('figma-dashboard.ManualPlanning.dedf299b8b', {
              value0: formatClock(window.startAt ?? 0),
              value1: formatClock(window.endAt ?? 0),
            })
          : t('figma-dashboard.ManualPlanning.e8ce4d0ae3')}
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
      {kind === 'shift'
        ? t('figma-dashboard.ManualPlanning.dd3482fc72')
        : t('figma-dashboard.ManualPlanning.2d040ef9ab')}
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
