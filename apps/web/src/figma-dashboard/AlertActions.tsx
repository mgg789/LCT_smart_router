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
import { DashboardApiError, loadAlertWindowProposal } from '../api/client';
import type { AlertResolutionInput, AlertView, DashboardSnapshot } from '../api/types';
import {
  ALERT_ACTION_SPECS,
  type AlertActionId,
  type AlertActionSpec,
  alertWindowInput,
  alertWindowSeconds,
  isAlertActionId,
} from '../domain/alerts';
import { InboxButton } from './inboxCard';

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
              Вариант «{action}» требует обновления интерфейса.
            </span>
          ),
        )}
        <ExplainedAction
          icon={Sparkles}
          appearance="ai"
          disabled={disabled || waiting || pending || thinking || !token || !alert}
          thinking={thinking}
          spec={{
            label: 'Решить с AI',
            summary: 'System one выбирает допустимое действие и применяет его.',
            effect: 'Сервер проверяет ответ по списку и проводит обычное решение алерта.',
            benefit: 'Не нужно выбирать вариант вручную, если список уже известен.',
            drawback: 'Смена окна сюда не входит: время модель не назначает.',
            tone: 'ink',
          }}
          onClick={() => {
            if (!token || !alert || pending || thinking) return;
            onAskAi?.();
          }}
        />
      </div>
      {token && alert && actions.includes('move_window') ? (
        <WindowAiNote token={token} alertId={alert.id} />
      ) : null}
      {disabled && actions.length > 0 ? (
        <p className="mt-[12px] text-[16px] text-figma-muted">
          Решения доступны при подключении к рабочему серверу и завершении текущей операции.
        </p>
      ) : null}
      {waiting ? (
        <p role="status" className="mt-[12px] text-[16px] text-figma-muted">
          Ожидаем применения автоматического плана. Алерт остаётся открытым до подтверждения
          сервера.
        </p>
      ) : null}
      {alert?.resolutionAction === 'move_window' && alert.resolvedAt === null ? (
        <p role="status" className="mt-[12px] text-[16px] text-figma-muted">
          Окно изменено. Алерт останется открытым, пока заявка не получит назначение.
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
    <fieldset
      ref={anchor}
      className="inline-flex"
      tabIndex={disabled ? 0 : undefined}
      aria-label={disabled ? `${spec.label}: недоступно` : undefined}
      aria-describedby={id}
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
          className="relative flex items-center justify-center overflow-clip rounded-[20px] bg-figma-ink px-[32px] py-[16px] font-semibold text-[20px] tracking-[-0.6px] disabled:cursor-not-allowed disabled:opacity-45"
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
          <span className="panel-ai-fill client-ai-text">{spec.label}</span>
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
        {spec.summary} {spec.effect} Плюсы: {spec.benefit} Минусы: {spec.drawback}
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
                <strong>Что произойдёт: </strong>
                {spec.effect}
              </p>
              <p className="mt-[8px]">
                <strong>Плюсы: </strong>
                {spec.benefit}
              </p>
              <p className="mt-[8px]">
                <strong>Минусы: </strong>
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
  const [text, setText] = useState('AI проверяет, есть ли сегодня окно для сдвига…');
  useEffect(() => {
    let active = true;
    void loadAlertWindowProposal(token, alertId)
      .then((result) => {
        if (!active) return;
        const offer = result.proposal;
        setText(
          result.status === 'available' && offer
            ? `AI может сдвинуть окно на ${alertWindowInput(offer.windowStartAt)}–${alertWindowInput(offer.windowEndAt)}.`
            : 'Сегодня нет окон, куда можно сдвинуть визит.',
        );
      })
      .catch(() => {
        if (active) setText('Сегодня не удалось проверить окно для сдвига.');
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
  const [proposalText, setProposalText] = useState('Подбираем выполнимое окно через Router…');
  useEffect(() => {
    if (action !== 'move_window') return;
    let active = true;
    if (!token) {
      setProposalStatus('unavailable');
      setProposalText('Подбор доступен только при подключении к рабочему серверу.');
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
          setProposalText(
            'Найдено выполнимое окно с учётом дороги и текущего маршрута инженера. Это расчёт, не резервирование; алёрт останется до подтверждённого назначения.',
          );
        } else
          setProposalText(
            'В текущих маршрутах на сегодня выполнимое окно не найдено. Рекомендуем «На завтра». Можно задать окно вручную — алёрт останется до назначения.',
          );
      })
      .catch(() => {
        if (!active) return;
        setProposalStatus('unavailable');
        setProposalText(
          'Не удалось проверить окно через Router. Это не означает, что окна нет. Закройте и повторите подбор или укажите окно вручную.',
        );
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
  async function submit() {
    if (lock.current || disabled) return;
    lock.current = true;
    onPending(true);
    setPending(true);
    setError(null);
    try {
      if (!(alert.actions ?? []).includes(action) || alert.resolvedAt !== null)
        throw new Error('Этот вариант больше недоступен. Обновите список алертов.');
      const input: Omit<AlertResolutionInput, 'operationId'> = {
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
        throw new Error('Укажите причину сохранения ручного плана.');
      if (action === 'add_engineer' && !candidates.some((item) => item.id === engineerId))
        throw new Error('Выберите доступного инженера.');
      if (
        input.windowStartAt !== undefined &&
        input.windowEndAt !== undefined &&
        input.windowEndAt <= input.windowStartAt
      )
        throw new Error('Конец окна должен быть позже начала.');
      if (
        input.minutes !== undefined &&
        (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 240)
      )
        throw new Error('Укажите от 1 до 240 целых минут.');
      const fingerprint = JSON.stringify(input);
      if (retry.current?.fingerprint !== fingerprint)
        retry.current = { fingerprint, operationId: crypto.randomUUID() };
      await onResolve(alert.id, { ...input, operationId: retry.current.operationId });
      onClose();
    } catch (cause) {
      if (cause instanceof DashboardApiError && cause.status >= 400 && cause.status < 500)
        retry.current = null;
      setError(
        cause instanceof Error ? cause.message : 'Не удалось применить решение. Повторите попытку.',
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
              Начало окна (Москва)
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
              Конец окна (Москва)
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
            Дополнительный инженер
            <select
              required
              value={engineerId}
              onChange={(e) => setEngineerId(e.target.value)}
              className={fieldClass}
            >
              <option value="">Выберите инженера</option>
              {candidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
            <span className="mt-[8px] block text-[16px] text-figma-muted">
              {candidates.length
                ? 'Сервер дополнительно проверит совместимость транспорта и актуальность смены.'
                : 'Нет подходящих инженеров вне линии. Проверьте состав и смены во вкладке «Инженеры».'}
            </span>
          </label>
        ) : null}
        {spec.input === 'minutes' ? (
          alert.code === 'shift_no_show' ? (
            <p>Ожидание будет продлено на 15 минут.</p>
          ) : (
            <label className="block">
              Дополнительное время, мин.
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
            ? 'Причина (обязательно)'
            : spec.input === 'message'
              ? 'Сообщение инженеру (необязательно)'
              : 'Комментарий (необязательно)'}
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
            {pending ? 'Применяем…' : 'Применить решение'}
          </button>
          <InboxButton variant="outline" onClick={onClose}>
            Отмена
          </InboxButton>
        </div>
      </fieldset>
    </form>
  );
}
