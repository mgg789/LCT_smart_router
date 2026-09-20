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
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DashboardApiError } from '../api/client';
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
  alert,
  snapshot,
  disabled,
  onResolve,
}: {
  alert: AlertView | null;
  snapshot: DashboardSnapshot | null;
  disabled: boolean;
  onResolve: (id: string, input: AlertResolutionInput) => Promise<void>;
}) {
  const [selected, setSelected] = useState<AlertActionId | null>(null);
  const [pending, setPending] = useState(false);
  const waiting = alert?.resolutionAction === 'restore_auto';
  const actions = [...new Set(alert?.actions ?? [])];
  return (
    <div className="mt-[20px]">
      <div className="flex flex-wrap gap-[12px]">
        {actions.map((action) =>
          isAlertActionId(action) ? (
            <ExplainedAction
              key={action}
              spec={ALERT_ACTION_SPECS[action]}
              icon={ACTION_ICONS[action]}
              disabled={disabled || waiting || pending}
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
          disabled
          spec={{
            label: 'Включить AI',
            summary: 'AI-разбор этого алерта пока недоступен.',
            effect: 'Сервис AI ещё не подключён. Выберите один из ручных вариантов.',
            benefit: 'После подключения поможет сравнить допустимые решения.',
            drawback: 'Сейчас кнопка не выполняет действий.',
            tone: 'ink',
          }}
        />
      </div>
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
      {selected && alert && snapshot && !waiting ? (
        <ResolutionForm
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
  onClick,
}: {
  icon: LucideIcon;
  spec: Pick<AlertActionSpec, 'label' | 'summary' | 'effect' | 'benefit' | 'drawback' | 'tone'>;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const id = useId();
  const anchor = useRef<HTMLFieldSetElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  function hide() {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPosition(null), 150);
  }
  function show() {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const rect = anchor.current?.getBoundingClientRect();
    if (rect)
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)),
        top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 300)),
      });
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
      onBlur={() => setPosition(null)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setPosition(null);
      }}
    >
      <InboxButton variant={spec.tone} disabled={disabled} describedBy={id} onClick={onClick}>
        <Icon size={22} strokeWidth={1.8} aria-hidden="true" className="mr-[10px] shrink-0" />
        {spec.label}
      </InboxButton>
      <span id={id} className="sr-only">
        {spec.summary} {spec.effect} Плюсы: {spec.benefit} Минусы: {spec.drawback}
      </span>
      {position
        ? createPortal(
            <div
              role="tooltip"
              className="fixed z-[999] max-h-[280px] w-[360px] max-w-[calc(100vw-16px)] overflow-auto rounded-[16px] border border-figma-ink/20 bg-white p-[16px] text-[14px] leading-relaxed text-figma-ink shadow-xl"
              style={position}
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
            </div>,
            document.body,
          )
        : null}
    </fieldset>
  );
}

function ResolutionForm({
  action,
  alert,
  snapshot,
  disabled,
  onResolve,
  onClose,
  onPending,
}: {
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
  const [start, setStart] = useState(request ? alertWindowInput(request.windowStartAt) : '');
  const [end, setEnd] = useState(request ? alertWindowInput(request.windowEndAt) : '');
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
          ? { windowStartAt: alertWindowSeconds(start), windowEndAt: alertWindowSeconds(end) }
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
            <label>
              Начало окна (Москва)
              <input
                required
                type="datetime-local"
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
            disabled={action === 'add_engineer' && candidates.length === 0}
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
