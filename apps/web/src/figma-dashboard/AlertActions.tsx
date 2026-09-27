import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  CalendarClock,
  CalendarDays,
  Check,
  ClipboardCheck,
  type LucideIcon,
  Mail,
  MailMinus,
  RotateCcw,
  Sparkles,
  Timer,
  UserRoundMinus,
  UserRoundPlus,
  Utensils,
  UtensilsCrossed,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DashboardApiError,
  loadAlertWindowProposal,
  loadRequestPriority,
  simulateChange,
  simulationWorsens,
} from '../api/client';
import type { AlertResolutionInput, AlertView, DashboardSnapshot } from '../api/types';
import {
  ALERT_ACTION_SPECS,
  type AlertActionId,
  type AlertActionSpec,
  alertWindowInput,
  alertWindowSeconds,
  isAlertActionId,
} from '../domain/alerts';
import { isNavixOffline } from '../domain/mapAvailability';
import { t } from '../i18n';
import { InboxButton } from './inboxCard';
import { WorsenModal } from './WorsenModal';

const fieldClass =
  'mt-[8px] block w-full rounded-[12px] border border-figma-ink/30 bg-white p-[12px] text-[18px] text-figma-ink focus:outline-figma-ink';

const ACTION_ICONS: Record<AlertActionId, LucideIcon> = {
  reschedule: CalendarDays,
  move_window: CalendarClock,
  add_engineer: UserRoundPlus,
  keep_manual: ClipboardCheck,
  keep_as_is: Check,
  restore_auto: RotateCcw,
  skip_lunch: UtensilsCrossed,
  keep_lunch: Utensils,
  message: Mail,
  remove_shift: UserRoundMinus,
  message_remove: MailMinus,
  extend: Timer,
  make_passive: UserRoundMinus,
  prioritize: Sparkles,
};

/** Server-authorized choices with accessible explanations and real resolution forms. */
export function AlertActions({
  token,
  alert,
  snapshot,
  disabled,
  onResolve,
  leadingAction,
  spotlightAction = null,
  thinking = false,
  onAskAi,
}: {
  token?: string;
  alert: AlertView | null;
  snapshot: DashboardSnapshot | null;
  disabled: boolean;
  onResolve: (id: string, input: AlertResolutionInput) => Promise<void>;
  /** Optional navigation action rendered before the server-authorized decisions. */
  leadingAction?: ReactNode;
  /** Gradient ring on the action System one just chose. */
  spotlightAction?: string | null;
  /** Shimmer while System one has not answered yet. */
  thinking?: boolean;
  /** Starts the choose-then-apply sequence owned by the inbox. */
  onAskAi?: () => void;
}) {
  const [selected, setSelected] = useState<AlertActionId | null>(null);
  const [pending, setPending] = useState(false);
  const offline = isNavixOffline();
  const waiting = alert?.resolutionAction === 'restore_auto';
  const actions = [...new Set(alert?.actions ?? [])];
  return (
    <div className="mt-[20px]">
      <div className="flex flex-wrap gap-[12px]">
        {leadingAction}
        {actions.map((action) =>
          isAlertActionId(action) ? (
            <ExplainedAction
              key={action}
              spec={ALERT_ACTION_SPECS[action]}
              icon={ACTION_ICONS[action]}
              disabled={disabled || waiting || pending}
              spotlight={spotlightAction === action}
              onClick={() => setSelected(action)}
            />
          ) : (
            <span key={action} className="text-[16px] text-figma-muted">
              {t('figma-dashboard.AlertActions.9eda61a9ac')}
              {action}
              {t('figma-dashboard.AlertActions.6b766517ee')}
            </span>
          ),
        )}
        <ExplainedAction
          icon={Sparkles}
          appearance="ai"
          disabled={offline || disabled || waiting || pending || thinking || !token || !alert}
          thinking={thinking}
          title={offline ? t('common.offlineContour') : undefined}
          spec={{
            label: t('figma-dashboard.AlertActions.29476f2252'),
            summary: t('figma-dashboard.AlertActions.22eee1186f'),
            effect: t('figma-dashboard.AlertActions.e56e25835f'),
            benefit: t('figma-dashboard.AlertActions.2171ab0983'),
            drawback: t('figma-dashboard.AlertActions.cf21c65f01'),
            tone: 'ink',
          }}
          onClick={() => {
            if (!token || !alert || pending || thinking) return;
            onAskAi?.();
          }}
        />
      </div>
      {!offline && token && alert && actions.includes('move_window') ? (
        <WindowAiNote token={token} alertId={alert.id} />
      ) : null}
      {disabled && actions.length > 0 ? (
        <p className="mt-[12px] text-[16px] text-figma-muted">
          {t('figma-dashboard.AlertActions.432b8f6b3a')}
        </p>
      ) : null}
      {waiting ? (
        <p role="status" className="mt-[12px] text-[16px] text-figma-muted">
          {t('figma-dashboard.AlertActions.d03273ed80')}
        </p>
      ) : null}
      {alert?.resolutionAction === 'move_window' && alert.resolvedAt === null ? (
        <p role="status" className="mt-[12px] text-[16px] text-figma-muted">
          {t('figma-dashboard.AlertActions.c8486df0d9')}
        </p>
      ) : null}
      {selected && alert && snapshot && !waiting ? (
        <ResolutionForm
          token={token}
          key={`${alert.id}:${selected}`}
          action={selected}
          alert={alert}
          snapshot={snapshot}
          disabled={disabled}
          onResolve={onResolve}
          onClose={() => setSelected(null)}
          onPending={setPending}
        />
      ) : null}
    </div>
  );
}

function ExplainedAction({
  icon: Icon,
  spec,
  disabled = false,
  appearance = 'plain',
  spotlight = false,
  thinking = false,
  onClick,
  title,
}: {
  icon: LucideIcon;
  spec: Pick<AlertActionSpec, 'label' | 'summary' | 'effect' | 'benefit' | 'drawback' | 'tone'>;
  disabled?: boolean;
  /** `ai` uses the light panel gradient and runs System one when clicked. */
  appearance?: 'plain' | 'ai';
  /** Brand gradient outline. The sweep does not click the button. */
  spotlight?: boolean;
  /** Moving highlight while the model has not answered. */
  thinking?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const anchor = useRef<HTMLFieldSetElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (showTimer.current) clearTimeout(showTimer.current);
    },
    [],
  );
  function hide() {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = null;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPosition(null), 220);
  }
  function show() {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (showTimer.current || position) return;
    showTimer.current = setTimeout(() => {
      showTimer.current = null;
      const rect = anchor.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)),
          top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 300)),
        });
    }, 700);
  }
  function dismiss() {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = null;
    setPosition(null);
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Tooltip events bubble from the keyboard-accessible native action buttons.
    <fieldset
      ref={anchor}
      className="m-0 inline-flex min-w-0 border-0 p-0"
      tabIndex={disabled ? 0 : undefined}
      aria-label={
        disabled ? t('figma-dashboard.AlertActions.9baa6ef546', { value0: spec.label }) : undefined
      }
      aria-describedby={id}
      title={title}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={dismiss}
      onPointerDown={dismiss}
      onKeyDown={(event) => {
        if (event.key === 'Escape') dismiss();
      }}
    >
      {appearance === 'ai' ? (
        <button
          type="button"
          disabled={disabled}
          aria-describedby={id}
          onClick={() => {
            dismiss();
            onClick?.();
          }}
          className={`relative box-border flex h-[62px] max-h-[62px] min-h-[62px] shrink-0 items-center justify-center overflow-hidden rounded-[20px] bg-figma-ink px-[32px] font-semibold text-[20px] leading-none tracking-[-0.6px] disabled:cursor-not-allowed ${thinking ? 'brightness-90' : ''} ${disabled && !thinking ? 'opacity-45' : ''}`}
          style={{ height: 62, minHeight: 62, maxHeight: 62 }}
        >
          {thinking ? (
            <span aria-hidden className="ai-reason-shimmer pointer-events-none absolute inset-0" />
          ) : null}
          <span
            aria-hidden
            className="panel-ai-fill mr-[10px] block size-[22px] shrink-0"
            style={{
              WebkitMaskImage: 'url(/figma/explain-ai.png)',
              maskImage: 'url(/figma/explain-ai.png)',
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center',
              maskPosition: 'center',
              WebkitMaskSize: 'contain',
              maskSize: 'contain',
            }}
          />
          <span className="panel-ai-fill client-ai-text whitespace-nowrap leading-none">
            {spec.label}
          </span>
        </button>
      ) : (
        <span className={spotlight ? 'ai-choice-ring rounded-[24px]' : undefined}>
          <InboxButton
            variant={spec.tone}
            disabled={disabled}
            describedBy={id}
            onClick={() => {
              dismiss();
              onClick?.();
            }}
          >
            <Icon size={22} strokeWidth={1.8} aria-hidden="true" className="mr-[10px] shrink-0" />
            {spec.label}
          </InboxButton>
        </span>
      )}
      <span id={id} className="sr-only">
        {spec.summary} {spec.effect}
        {t('figma-dashboard.AlertActions.5a573dacd4')}
        {spec.benefit}
        {t('figma-dashboard.AlertActions.c3c0e35608')}
        {spec.drawback}
      </span>
      {typeof document === 'undefined'
        ? null
        : createPortal(
            <AnimatePresence>
              {position ? (
                <motion.div
                  key="alert-action-hint"
                  role="tooltip"
                  className="fixed z-[999] max-h-[280px] w-[360px] max-w-[calc(100vw-16px)] overflow-auto rounded-[16px] border border-figma-ink/20 bg-white p-[16px] text-[14px] leading-relaxed text-figma-ink shadow-xl"
                  style={{
                    left: position.left,
                    top: position.top,
                    transformOrigin: 'top center',
                    transformPerspective: 800,
                  }}
                  initial={reduceMotion ? false : { opacity: 0, rotateX: -18, scale: 0.94, y: -8 }}
                  animate={{ opacity: 1, rotateX: 0, scale: 1, y: 0 }}
                  exit={reduceMotion ? undefined : { opacity: 0, rotateX: -8, scale: 0.97, y: -4 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                  onMouseEnter={show}
                  onMouseLeave={hide}
                >
                  <p className="font-bold">{spec.label}</p>
                  <p>{spec.summary}</p>
                  <p className="mt-[8px]">
                    <strong>{t('figma-dashboard.AlertActions.035ddf5e16')}</strong>
                    {spec.effect}
                  </p>
                  <p className="mt-[8px]">
                    <strong>{t('figma-dashboard.AlertActions.2761e0962f')}</strong>
                    {spec.benefit}
                  </p>
                  <p className="mt-[8px]">
                    <strong>{t('figma-dashboard.AlertActions.3fd4b46e09')}</strong>
                    {spec.drawback}
                  </p>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )}
    </fieldset>
  );
}

function WindowAiNote({ token, alertId }: { token: string; alertId: string }) {
  const [text, setText] = useState(t('figma-dashboard.AlertActions.33581244d6'));
  useEffect(() => {
    let active = true;
    void loadAlertWindowProposal(token, alertId)
      .then((result) => {
        if (!active) return;
        const offer = result.proposal;
        setText(
          result.status === 'available' && offer
            ? t('figma-dashboard.AlertActions.f6f4399d97', {
                value0: alertWindowInput(offer.windowStartAt),
                value1: alertWindowInput(offer.windowEndAt),
              })
            : t('figma-dashboard.AlertActions.143a384ad6'),
        );
      })
      .catch(() => {
        if (active) setText(t('figma-dashboard.AlertActions.cb869b60e8'));
      });
    return () => {
      active = false;
    };
  }, [alertId, token]);
  return <p className="mt-[12px] text-[16px] text-figma-muted">{text}</p>;
}

function ResolutionForm({
  token,
  action,
  alert,
  snapshot,
  disabled,
  onResolve,
  onClose,
  onPending,
}: {
  token?: string;
  action: AlertActionId;
  alert: AlertView;
  snapshot: DashboardSnapshot;
  disabled: boolean;
  onResolve: (id: string, input: AlertResolutionInput) => Promise<void>;
  onClose: () => void;
  onPending: (value: boolean) => void;
}) {
  const spec = ALERT_ACTION_SPECS[action];
  const request = snapshot.requests.find((item) => item.id === alert.requestIds[0]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [expectedRequestVersion, setExpectedRequestVersion] = useState(request?.version);
  const [proposalStatus, setProposalStatus] = useState('loading');
  const [proposalText, setProposalText] = useState(t('figma-dashboard.AlertActions.099189b8c4'));
  useEffect(() => {
    if (action !== 'move_window' || isNavixOffline()) return;
    let active = true;
    if (!token) {
      setProposalStatus('unavailable');
      setProposalText(t('figma-dashboard.AlertActions.90f68f2e16'));
      return;
    }
    void loadAlertWindowProposal(token, alert.id)
      .then((result) => {
        if (!active) return;
        setExpectedRequestVersion(result.requestVersion);
        setProposalStatus(result.status);
        if (result.proposal) {
          setStart(alertWindowInput(result.proposal.windowStartAt));
          setEnd(alertWindowInput(result.proposal.windowEndAt));
          setProposalText(t('figma-dashboard.AlertActions.b16175e011'));
        } else setProposalText(t('figma-dashboard.AlertActions.7e04b8e3d7'));
      })
      .catch(() => {
        if (!active) return;
        setProposalStatus('unavailable');
        setProposalText(t('figma-dashboard.AlertActions.cbd6e7db44'));
      });
    return () => {
      active = false;
    };
  }, [action, alert.id, token]);
  const [reason, setReason] = useState('');
  const [engineerId, setEngineerId] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [windowWarning, setWindowWarning] = useState<string | null>(null);
  const windowResolve = useRef<((accepted: boolean) => void) | null>(null);
  const lock = useRef(false);
  const retry = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const candidates = snapshot.engineers.filter(
    (engineer) =>
      request &&
      request.lifecycle === 'submitted' &&
      engineer.day?.availability === 'offline' &&
      engineer.day.workDate === alert.workDate &&
      engineer.skills.includes(request.requiredSkill) &&
      (!request.region || engineer.region === request.region) &&
      engineer.day.shiftStartAt <= request.windowStartAt &&
      engineer.day.shiftEndAt >= request.windowEndAt,
  );
  const [priorityWarning, setPriorityWarning] = useState(false);
  const priorityResolve = useRef<((accepted: boolean) => void) | null>(null);
  useEffect(() => () => priorityResolve.current?.(false), []);
  async function submit() {
    if (lock.current || disabled) return;
    lock.current = true;
    onPending(true);
    setPending(true);
    setError(null);
    try {
      if (!(alert.actions ?? []).includes(action) || alert.resolvedAt !== null)
        throw new Error(t('figma-dashboard.AlertActions.27e20f534d'));
      let expectedPriorityVersion: string | undefined;
      if (action === 'prioritize') {
        if (isNavixOffline() || !token || !alert.workDate)
          throw new Error(t('figma-dashboard.AlertActions.7b1fa03ae0'));
        const { priority } = await loadRequestPriority(token, alert.workDate);
        if (priority && priority.requestId !== alert.requestIds[0]) {
          const accepted = await new Promise<boolean>((resolve) => {
            priorityResolve.current = resolve;
            setPriorityWarning(true);
          });
          setPriorityWarning(false);
          priorityResolve.current = null;
          if (!accepted) return;
          expectedPriorityVersion = priority.version;
        }
      }
      const input: Omit<AlertResolutionInput, 'operationId'> = {
        ...(expectedPriorityVersion ? { expectedPriorityVersion } : {}),
        action,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(action === 'move_window'
          ? {
              windowStartAt: alertWindowSeconds(start),
              windowEndAt: alertWindowSeconds(end),
              expectedRequestVersion,
            }
          : {}),
        ...(action === 'add_engineer' ? { engineerId } : {}),
        ...(action === 'extend' ? { minutes: alert.code === 'shift_no_show' ? 15 : minutes } : {}),
      };
      if (action === 'keep_manual' && !reason.trim())
        throw new Error(t('figma-dashboard.AlertActions.207ed55c4f'));
      if (action === 'add_engineer' && !candidates.some((item) => item.id === engineerId))
        throw new Error(t('figma-dashboard.AlertActions.95e4d5cb8c'));
      if (
        input.windowStartAt !== undefined &&
        input.windowEndAt !== undefined &&
        input.windowEndAt <= input.windowStartAt
      )
        throw new Error(t('figma-dashboard.AlertActions.868110d225'));
      if (
        action === 'move_window' &&
        token &&
        request &&
        input.windowStartAt &&
        input.windowEndAt
      ) {
        try {
          const preview = await simulateChange(token, {
            window: {
              requestId: request.id,
              windowStartAt: input.windowStartAt,
              windowEndAt: input.windowEndAt,
            },
          });
          if (simulationWorsens(preview.delta)) {
            const accepted = await new Promise<boolean>((resolve) => {
              windowResolve.current = resolve;
              setWindowWarning(preview.text);
            });
            setWindowWarning(null);
            windowResolve.current = null;
            if (!accepted) return;
          }
        } catch {
          // No stored answer: the window change can still be sent.
        }
      }
      if (
        input.minutes !== undefined &&
        (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 240)
      )
        throw new Error(t('figma-dashboard.AlertActions.8911886ff8'));
      const fingerprint = JSON.stringify(input);
      if (retry.current?.fingerprint !== fingerprint)
        retry.current = { fingerprint, operationId: crypto.randomUUID() };
      await onResolve(alert.id, { ...input, operationId: retry.current.operationId });
      onClose();
    } catch (cause) {
      if (cause instanceof DashboardApiError && cause.status >= 400 && cause.status < 500)
        retry.current = null;
      setError(
        cause instanceof Error ? cause.message : t('figma-dashboard.AlertActions.a275d333f3'),
      );
    } finally {
      lock.current = false;
      setPending(false);
      onPending(false);
    }
  }
  return (
    <form
      className="mt-[20px] rounded-[16px] bg-figma-soft p-[20px] text-[18px] text-figma-ink"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <WorsenModal
        title={t('figma-dashboard.AlertActions.6a37cd2d98')}
        cancelLabel={t('figma-dashboard.AlertActions.1a9fb1f3cf')}
        confirmLabel={t('figma-dashboard.AlertActions.c192b4bc78')}
        text={priorityWarning ? t('figma-dashboard.AlertActions.2db5af1cfa') : null}
        onCancel={() => priorityResolve.current?.(false)}
        onConfirm={() => priorityResolve.current?.(true)}
      />
      <h3 className="font-bold">{spec.label}</h3>
      <p className="mt-[8px]">{spec.summary}</p>
      <p className="mt-[8px] text-figma-muted">{spec.effect}</p>
      <fieldset disabled={disabled || pending} className="mt-[16px] space-y-[16px]">
        {spec.input === 'window' ? (
          <div className="flex flex-wrap gap-[20px]">
            <p role="status" className="w-full text-figma-muted">
              {proposalText}
            </p>
            <label>
              {t('figma-dashboard.AlertActions.8d7f6b9bb4')}
              <input
                required
                type="datetime-local"
                disabled={proposalStatus === 'loading'}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className={fieldClass}
              />
            </label>
            <label>
              {t('figma-dashboard.AlertActions.94d3ce22e5')}
              <input
                required
                type="datetime-local"
                disabled={proposalStatus === 'loading'}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className={fieldClass}
              />
            </label>
          </div>
        ) : null}
        {spec.input === 'engineer' ? (
          <label className="block">
            {t('figma-dashboard.AlertActions.0410b11c1c')}
            <select
              required
              value={engineerId}
              onChange={(e) => setEngineerId(e.target.value)}
              className={fieldClass}
            >
              <option value="">{t('figma-dashboard.AlertActions.36fc8b94f4')}</option>
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
            <span className="mt-[8px] block text-[16px] text-figma-muted">
              {candidates.length
                ? t('figma-dashboard.AlertActions.cab18c32f6')
                : t('figma-dashboard.AlertActions.d1df40457d')}
            </span>
          </label>
        ) : null}
        {spec.input === 'minutes' ? (
          alert.code === 'shift_no_show' ? (
            <p>{t('figma-dashboard.AlertActions.b4d82bc0a7')}</p>
          ) : (
            <label className="block">
              {t('figma-dashboard.AlertActions.a0ccaacaf7')}
              <input
                required
                type="number"
                min={1}
                max={240}
                step={1}
                value={minutes}
                onChange={(e) => setMinutes(e.target.valueAsNumber)}
                className={fieldClass}
              />
            </label>
          )
        ) : null}
        <label className="block">
          {spec.input === 'reason'
            ? t('figma-dashboard.AlertActions.c31a4497cc')
            : spec.input === 'message'
              ? t('figma-dashboard.AlertActions.1d0678167e')
              : t('figma-dashboard.AlertActions.781d9bde52')}
          <textarea
            required={spec.input === 'reason'}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={fieldClass}
          />
        </label>
        {error ? (
          <p role="alert" className="font-semibold">
            {error}
          </p>
        ) : null}
        <div className="flex gap-[12px]">
          <button
            type="submit"
            disabled={
              (action === 'add_engineer' && candidates.length === 0) ||
              (action === 'move_window' && proposalStatus === 'loading')
            }
            className="rounded-[20px] bg-figma-bee px-[32px] py-[16px] font-semibold disabled:opacity-45"
          >
            {pending
              ? t('figma-dashboard.AlertActions.b001f5d801')
              : t('figma-dashboard.AlertActions.efc540a528')}
          </button>
          <InboxButton variant="outline" onClick={onClose}>
            {t('figma-dashboard.AlertActions.8fbe9b75cb')}
          </InboxButton>
        </div>
      </fieldset>
      <WorsenModal
        text={windowWarning}
        onCancel={() => {
          setWindowWarning(null);
          windowResolve.current?.(false);
          windowResolve.current = null;
        }}
        onConfirm={() => {
          setWindowWarning(null);
          windowResolve.current?.(true);
          windowResolve.current = null;
        }}
      />
    </form>
  );
}
