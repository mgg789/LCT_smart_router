import { CalendarClock, CircleAlert, RefreshCw, WifiOff } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { DashboardApiError } from '../api/client';
import {
  cancelClientRequest,
  loadClientRequests,
  loadClientWorkTypes,
  prepareClientRequest,
  requestClientLoginCode,
  rescheduleClientRequest,
  signOutClient,
  submitClientRequest,
  verifyClientLoginCode,
} from '../api/client-contour';
import type { ClientWorkType, EquipmentType, RequestView } from '../api/types';
import { clearClientSession, readClientSession, writeClientSession } from '../client/session';
import { AiUnavailablePanel } from '../components/ai/AiUnavailablePanel';
import { ChatMessage } from '../components/ai/ChatMessage';
import { HandoffBanner } from '../components/ai/HandoffBanner';
import { moscowTimeInputAt } from '../engineer/live';
import { useAssistantChat } from '../hooks/useAssistantChat';
import { formatClock } from '../lib/time';

type ClientTab = 'requests' | 'new' | 'assistant';

/** Client App shell: email-code login, the customer's own requests, the assistant chat and
 * its required plain-form fallback. Routes live under `/client*`. */
export function ClientApp() {
  const [tab, setTab] = useState<ClientTab>(() => parseClientPath(window.location.pathname));
  const [token, setToken] = useState<string | null>(
    () => readClientSession(window.localStorage)?.token ?? null,
  );

  useEffect(() => {
    const onPop = () => setTab(parseClientPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: ClientTab) => {
    const href = hrefForClientTab(next);
    if (window.location.pathname !== href) {
      window.history.pushState({}, '', href);
    }
    setTab(next);
  }, []);

  const onSignedIn = useCallback(
    (nextToken: string, expiresAt: number) => {
      writeClientSession(window.localStorage, { token: nextToken, expiresAt });
      setToken(nextToken);
      navigate('requests');
    },
    [navigate],
  );

  const onSignedOut = useCallback(async () => {
    if (token) {
      try {
        await signOutClient(token);
      } catch {
        // Local sign-out still proceeds: the device must forget the token even if the
        // revoke call cannot reach the API.
      }
    }
    clearClientSession(window.localStorage);
    setToken(null);
    navigate('requests');
  }, [navigate, token]);

  if (token === null) {
    return <ClientLoginPage onSignedIn={onSignedIn} />;
  }

  return (
    <ClientSignedIn
      token={token}
      tab={tab}
      navigate={navigate}
      onSignedOut={() => void onSignedOut()}
      onSessionExpired={() => {
        clearClientSession(window.localStorage);
        setToken(null);
      }}
    />
  );
}

function ClientLoginPage({
  onSignedIn,
}: {
  readonly onSignedIn: (token: string, expiresAt: number) => void;
}) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<{ email: string; devCode?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const issuedCode = await requestClientLoginCode(email);
      setIssued({
        email: issuedCode.email,
        ...(issuedCode.devCode ? { devCode: issuedCode.devCode } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить код');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (issued === null) return;
    setBusy(true);
    setError(null);
    try {
      const session = await verifyClientLoginCode(issued.email, code);
      onSignedIn(session.token, session.expiresAt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Код не подошёл');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4">
      <form
        className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void (issued ? verify() : requestCode());
        }}
      >
        <img src="/beeline-symbol.png" alt="Beeline" className="mx-auto h-10 w-10" />
        <h1 className="mt-4 text-center text-xl font-semibold">Личный кабинет</h1>
        <p className="mt-2 text-center text-sm text-muted">
          Почта и код из письма. Заявки видны только вам.
        </p>
        <label className="mt-6 block text-sm">
          Почта
          <input
            type="email"
            required
            value={email}
            disabled={issued !== null}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-2xl border border-line px-3 py-2"
          />
        </label>
        {issued ? (
          <label className="mt-4 block text-sm">
            Код
            <input
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              className="mt-1 w-full rounded-2xl border border-line px-3 py-2 tracking-widest"
            />
          </label>
        ) : null}
        {issued?.devCode ? (
          <p className="mt-2 text-xs text-muted">Код для локальной отладки: {issued.devCode}</p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-700">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-full bg-bee py-3 text-sm font-semibold disabled:opacity-50"
        >
          {issued ? 'Войти' : 'Получить код'}
        </button>
        {issued ? (
          <button
            type="button"
            onClick={() => {
              setIssued(null);
              setCode('');
            }}
            className="mt-3 w-full text-sm text-muted underline"
          >
            Другая почта
          </button>
        ) : null}
      </form>
    </div>
  );
}

function ClientSignedIn({
  token,
  tab,
  navigate,
  onSignedOut,
  onSessionExpired,
}: {
  readonly token: string;
  readonly tab: ClientTab;
  readonly navigate: (tab: ClientTab) => void;
  readonly onSignedOut: () => void;
  readonly onSessionExpired: () => void;
}) {
  const online = useOnlineStatus();
  const [workTypes, setWorkTypes] = useState<ClientWorkType[]>([]);
  const [requests, setRequests] = useState<RequestView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const chat = useAssistantChat({ token, surface: 'client' });

  const reload = useCallback(async () => {
    if (!online) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [nextWorkTypes, nextRequests] = await Promise.all([
        loadClientWorkTypes(token),
        loadClientRequests(token),
      ]);
      setWorkTypes(nextWorkTypes);
      setRequests(nextRequests);
    } catch (cause) {
      if (cause instanceof DashboardApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setLoadError(cause instanceof Error ? cause.message : 'Не удалось загрузить заявки');
    } finally {
      setLoading(false);
    }
  }, [online, onSessionExpired, token]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload is stable per (token, online)
  useEffect(() => {
    void reload();
  }, [token, online]);

  const onReschedule = useCallback(
    async (
      id: string,
      input: { windowStartAt: number; windowEndAt: number; expectedVersion: number },
    ) => {
      setBusyId(id);
      setActionError(null);
      try {
        const updated = await rescheduleClientRequest(token, id, input);
        setRequests((current) =>
          current ? current.map((item) => (item.id === id ? updated : item)) : current,
        );
      } catch (cause) {
        if (cause instanceof DashboardApiError && cause.status === 401) {
          onSessionExpired();
          return;
        }
        setActionError(cause instanceof Error ? cause.message : 'Не удалось перенести заявку');
      } finally {
        setBusyId(null);
      }
    },
    [onSessionExpired, token],
  );

  const onCancel = useCallback(
    async (id: string, input: { reason?: string; expectedVersion: number }) => {
      setBusyId(id);
      setActionError(null);
      try {
        const updated = await cancelClientRequest(token, id, input);
        setRequests((current) =>
          current ? current.map((item) => (item.id === id ? updated : item)) : current,
        );
      } catch (cause) {
        if (cause instanceof DashboardApiError && cause.status === 401) {
          onSessionExpired();
          return;
        }
        setActionError(cause instanceof Error ? cause.message : 'Не удалось отменить заявку');
      } finally {
        setBusyId(null);
      }
    },
    [onSessionExpired, token],
  );

  const onCreated = useCallback((created: RequestView) => {
    setRequests((current) => (current ? [created, ...current] : [created]));
  }, []);

  const newRequestForm = (
    <ClientNewRequestSection
      token={token}
      workTypes={workTypes}
      disabled={!online}
      onSessionExpired={onSessionExpired}
      onCreated={onCreated}
    />
  );

  return (
    <div className="flex min-h-full flex-col bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-line bg-white px-4 py-3">
        <button
          type="button"
          onClick={() => navigate('requests')}
          className="flex items-center gap-2"
        >
          <img src="/beeline-symbol.png" alt="Beeline" className="h-8 w-8" />
          <span className="text-sm font-semibold">Личный кабинет</span>
        </button>
        <button type="button" onClick={onSignedOut} className="text-sm text-muted underline">
          Выйти
        </button>
      </header>

      {!online ? (
        <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          <WifiOff className="h-4 w-4 shrink-0" />
          Нет связи с сетью. Заявки и ассистент недоступны, форма откроется при подключении.
        </div>
      ) : chat.unavailable === 'quota' ? (
        <button
          type="button"
          onClick={() => navigate('new')}
          className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-left text-xs text-amber-900"
        >
          <CircleAlert className="h-4 w-4 shrink-0" />
          Дневная квота ассистента исчерпана. Заявку можно оформить формой — нажмите, чтобы открыть
          её.
        </button>
      ) : null}

      <nav className="flex gap-1 border-b border-line bg-white px-4">
        <TabButton
          label="Мои заявки"
          active={tab === 'requests'}
          onClick={() => navigate('requests')}
        />
        <TabButton label="Новая заявка" active={tab === 'new'} onClick={() => navigate('new')} />
        <TabButton
          label="Ассистент"
          active={tab === 'assistant'}
          onClick={() => navigate('assistant')}
        />
      </nav>

      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-4">
        {tab === 'requests' ? (
          <ClientRequestsList
            loading={loading}
            error={loadError}
            offline={!online}
            requests={requests ?? []}
            onReload={() => void reload()}
            onReschedule={onReschedule}
            onCancel={onCancel}
            busyId={busyId}
            actionError={actionError}
          />
        ) : tab === 'new' ? (
          newRequestForm
        ) : (
          <ClientAssistantTab chat={chat} fallbackForm={newRequestForm} />
        )}
      </main>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 px-3 py-2 text-sm font-medium ${
        active ? 'border-bee text-ink' : 'border-transparent text-muted'
      }`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------------------
// Requests list: loading / empty / error / offline states, plus reschedule and cancel.
// ---------------------------------------------------------------------------------------

const LIFECYCLE_LABEL: Record<RequestView['lifecycle'], string> = {
  draft: 'Черновик',
  submitted: 'Отправлена',
  in_progress: 'В работе',
  completed: 'Завершена',
  cancelled: 'Отменена',
};

const ASSIGNMENT_LABEL: Record<RequestView['assignmentState'], string> = {
  pending: 'Ожидает обработки',
  unassigned: 'Пока не назначена',
  assigned: 'Назначена бригаде',
  in_progress: 'Выполняется',
  done: 'Выполнена',
};

export interface ClientRequestsListProps {
  readonly loading: boolean;
  readonly error: string | null;
  readonly offline: boolean;
  readonly requests: readonly RequestView[];
  readonly onReload: () => void;
  readonly onReschedule: (
    id: string,
    input: { windowStartAt: number; windowEndAt: number; expectedVersion: number },
  ) => void;
  readonly onCancel: (id: string, input: { reason?: string; expectedVersion: number }) => void;
  readonly busyId: string | null;
  readonly actionError: string | null;
}

export function ClientRequestsList({
  loading,
  error,
  offline,
  requests,
  onReload,
  onReschedule,
  onCancel,
  busyId,
  actionError,
}: ClientRequestsListProps) {
  if (offline) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-white p-6 text-center text-sm text-muted">
        <WifiOff className="mx-auto h-6 w-6" />
        <p className="mt-2">Нет связи с сетью. Список заявок появится после подключения.</p>
      </div>
    );
  }
  if (loading) {
    return <p className="text-sm text-muted">Загружаем заявки…</p>;
  }
  if (error) {
    return (
      <div className="rounded-2xl bg-white p-4 text-sm">
        <p>{error}</p>
        <button
          type="button"
          onClick={onReload}
          className="mt-3 flex items-center gap-1.5 rounded-full bg-bee px-4 py-2 font-semibold"
        >
          <RefreshCw className="h-4 w-4" />
          Повторить
        </button>
      </div>
    );
  }
  if (requests.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-white p-6 text-center text-sm text-muted">
        Активных заявок пока нет.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {actionError ? (
        <p role="alert" className="rounded-xl bg-white px-3 py-2 text-sm text-red-700">
          {actionError}
        </p>
      ) : null}
      <ul className="space-y-3">
        {requests.map((request) => (
          <li key={request.id}>
            <ClientRequestCard
              request={request}
              busy={busyId === request.id}
              onReschedule={(input) => onReschedule(request.id, input)}
              onCancel={(input) => onCancel(request.id, input)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClientRequestCard({
  request,
  busy,
  onReschedule,
  onCancel,
}: {
  readonly request: RequestView;
  readonly busy: boolean;
  readonly onReschedule: (input: {
    windowStartAt: number;
    windowEndAt: number;
    expectedVersion: number;
  }) => void;
  readonly onCancel: (input: { reason?: string; expectedVersion: number }) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'reschedule' | 'cancel'>('idle');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const final = request.lifecycle === 'completed' || request.lifecycle === 'cancelled';

  return (
    <article className="rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {request.workTypeTitle ?? 'Заявка'}
        </p>
        {request.priority === 'urgent' ? (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] text-red-800">
            срочно
          </span>
        ) : null}
      </div>
      <h2 className="mt-1 font-semibold">{request.addressText}</h2>
      <p className="mt-1 text-sm text-muted">
        Окно {formatClock(request.windowStartAt)}–{formatClock(request.windowEndAt)}
      </p>
      <p className="mt-1 text-sm">
        {LIFECYCLE_LABEL[request.lifecycle]} · {ASSIGNMENT_LABEL[request.assignmentState]}
      </p>
      {request.problemText ? (
        <p className="mt-1 text-sm text-muted">{request.problemText}</p>
      ) : null}

      {!final && mode === 'idle' ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setMode('reschedule')}
            className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-xs font-semibold"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Перенести
          </button>
          <button
            type="button"
            onClick={() => setMode('cancel')}
            className="rounded-full border border-line px-3 py-1.5 text-xs font-semibold"
          >
            Отменить
          </button>
        </div>
      ) : null}

      {mode === 'reschedule' ? (
        <form
          className="mt-3 space-y-2 rounded-xl bg-canvas p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const windowStartAt = moscowTimeInputAt(date, startTime);
            const windowEndAt = moscowTimeInputAt(date, endTime);
            if (windowStartAt === null || windowEndAt === null || windowEndAt <= windowStartAt) {
              return;
            }
            onReschedule({ windowStartAt, windowEndAt, expectedVersion: request.version });
            setMode('idle');
          }}
        >
          <div className="flex gap-2">
            <input
              type="date"
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line px-2 py-1.5 text-sm"
            />
            <input
              type="time"
              required
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              className="w-24 rounded-lg border border-line px-2 py-1.5 text-sm"
            />
            <input
              type="time"
              required
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              className="w-24 rounded-lg border border-line px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-full bg-bee px-4 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Сохранить
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded-full border border-line px-4 py-1.5 text-xs"
            >
              Отмена
            </button>
          </div>
        </form>
      ) : null}

      {mode === 'cancel' ? (
        <form
          className="mt-3 space-y-2 rounded-xl bg-canvas p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onCancel({ ...(reason ? { reason } : {}), expectedVersion: request.version });
            setMode('idle');
          }}
        >
          <label className="block text-xs">
            Причина (необязательно)
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 w-full rounded-lg border border-line px-2 py-1.5 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-full bg-bee px-4 py-1.5 text-xs font-semibold disabled:opacity-50"
            >
              Подтвердить отмену
            </button>
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded-full border border-line px-4 py-1.5 text-xs"
            >
              Передумал(а)
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------------------
// New-request plain form: the required fallback, reachable independently of the assistant.
// ---------------------------------------------------------------------------------------

export interface ClientRequestDraft {
  readonly contactName: string;
  readonly addressText: string;
  readonly workType: string;
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly urgent: boolean;
  readonly problemText: string;
  readonly equipment: '' | EquipmentType;
}

export function emptyClientDraft(): ClientRequestDraft {
  return {
    contactName: '',
    addressText: '',
    workType: '',
    date: '',
    startTime: '',
    endTime: '',
    urgent: false,
    problemText: '',
    equipment: '',
  };
}

const EQUIPMENT_LABEL: Record<EquipmentType, string> = {
  router: 'Роутер',
  set_top_box: 'ТВ-приставка',
  smart_speaker: 'Умная колонка',
};

export interface ClientRequestFormProps {
  readonly workTypes: readonly ClientWorkType[];
  readonly value: ClientRequestDraft;
  readonly onChange: (patch: Partial<ClientRequestDraft>) => void;
  readonly onSubmit: () => void;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly success: string | null;
  readonly disabled?: boolean;
}

/**
 * The plain-form fallback to `POST /client/requests`. The product rule is that the chat is
 * an *alternative* to this form, not the other way round -- this component never depends on
 * the assistant being available.
 */
export function ClientRequestForm({
  workTypes,
  value,
  onChange,
  onSubmit,
  submitting,
  error,
  success,
  disabled,
}: ClientRequestFormProps) {
  const windowValid =
    moscowTimeInputAt(value.date, value.startTime) !== null &&
    moscowTimeInputAt(value.date, value.endTime) !== null &&
    (moscowTimeInputAt(value.date, value.endTime) as number) >
      (moscowTimeInputAt(value.date, value.startTime) as number);
  const canSubmit =
    !submitting &&
    !disabled &&
    value.contactName.trim().length > 0 &&
    value.addressText.trim().length > 0 &&
    value.workType.length > 0 &&
    windowValid;

  return (
    <form
      className="space-y-4 rounded-2xl bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <h2 className="text-lg font-semibold">Заявка без ассистента</h2>
      <label className="block text-sm">
        Контактное лицо
        <input
          required
          value={value.contactName}
          disabled={disabled}
          onChange={(event) => onChange({ contactName: event.target.value })}
          className="mt-1 w-full rounded-2xl border border-line px-3 py-2 disabled:opacity-50"
        />
      </label>
      <label className="block text-sm">
        Адрес
        <input
          required
          value={value.addressText}
          disabled={disabled}
          onChange={(event) => onChange({ addressText: event.target.value })}
          className="mt-1 w-full rounded-2xl border border-line px-3 py-2 disabled:opacity-50"
        />
      </label>
      <label className="block text-sm">
        Тип работ
        <select
          required
          value={value.workType}
          disabled={disabled}
          onChange={(event) => onChange({ workType: event.target.value })}
          className="mt-1 w-full rounded-2xl border border-line px-3 py-2 disabled:opacity-50"
        >
          <option value="">Выберите тип работ</option>
          {workTypes.map((type) => (
            <option key={type.code} value={type.code}>
              {type.title}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="block flex-1 text-sm">
          Дата
          <input
            type="date"
            required
            value={value.date}
            disabled={disabled}
            onChange={(event) => onChange({ date: event.target.value })}
            className="mt-1 w-full rounded-2xl border border-line px-3 py-2 disabled:opacity-50"
          />
        </label>
        <label className="block text-sm">
          С
          <input
            type="time"
            required
            value={value.startTime}
            disabled={disabled}
            onChange={(event) => onChange({ startTime: event.target.value })}
            className="mt-1 w-24 rounded-2xl border border-line px-3 py-2 disabled:opacity-50"
          />
        </label>
        <label className="block text-sm">
          До
          <input
            type="time"
            required
            value={value.endTime}
            disabled={disabled}
            onChange={(event) => onChange({ endTime: event.target.value })}
            className="mt-1 w-24 rounded-2xl border border-line px-3 py-2 disabled:opacity-50"
          />
        </label>
      </div>
      <label className="block text-sm">
        Оборудование (если нужно)
        <select
          value={value.equipment}
          disabled={disabled}
          onChange={(event) =>
            onChange({ equipment: event.target.value as ClientRequestDraft['equipment'] })
          }
          className="mt-1 w-full rounded-2xl border border-line px-3 py-2 disabled:opacity-50"
        >
          <option value="">Не требуется</option>
          {(Object.keys(EQUIPMENT_LABEL) as EquipmentType[]).map((code) => (
            <option key={code} value={code}>
              {EQUIPMENT_LABEL[code]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        Опишите проблему (необязательно)
        <textarea
          value={value.problemText}
          disabled={disabled}
          onChange={(event) => onChange({ problemText: event.target.value })}
          className="mt-1 min-h-20 w-full rounded-2xl border border-line px-3 py-2 disabled:opacity-50"
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.urgent}
          disabled={disabled}
          onChange={(event) => onChange({ urgent: event.target.checked })}
        />
        Срочная заявка
      </label>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {success ? <p className="text-sm text-emerald-700">{success}</p> : null}
      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded-full bg-bee py-3 text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? 'Отправляем…' : 'Отправить заявку'}
      </button>
    </form>
  );
}

function ClientNewRequestSection({
  token,
  workTypes,
  disabled,
  onSessionExpired,
  onCreated,
}: {
  readonly token: string;
  readonly workTypes: readonly ClientWorkType[];
  readonly disabled: boolean;
  readonly onSessionExpired: () => void;
  readonly onCreated: (created: RequestView) => void;
}) {
  const [draft, setDraft] = useState<ClientRequestDraft>(emptyClientDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const onChange = useCallback((patch: Partial<ClientRequestDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setSuccess(null);
  }, []);

  const onSubmit = useCallback(async () => {
    const windowStartAt = moscowTimeInputAt(draft.date, draft.startTime);
    const windowEndAt = moscowTimeInputAt(draft.date, draft.endTime);
    if (windowStartAt === null || windowEndAt === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const prepared = await prepareClientRequest(token, {
        contactName: draft.contactName,
        addressText: draft.addressText,
        workType: draft.workType,
        ...(draft.equipment ? { requiredEquipment: draft.equipment } : {}),
        windowStartAt,
        windowEndAt,
        urgent: draft.urgent,
        ...(draft.problemText.trim() ? { problemText: draft.problemText.trim() } : {}),
      });
      const submitted = await submitClientRequest(token, prepared.id, prepared.version);
      onCreated(submitted);
      setDraft(emptyClientDraft());
      setSuccess('Заявка отправлена.');
    } catch (cause) {
      if (cause instanceof DashboardApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Не удалось отправить заявку');
    } finally {
      setSubmitting(false);
    }
  }, [draft, onCreated, onSessionExpired, token]);

  return (
    <ClientRequestForm
      workTypes={workTypes}
      value={draft}
      onChange={onChange}
      onSubmit={() => void onSubmit()}
      submitting={submitting}
      error={error}
      success={success}
      disabled={disabled}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Assistant tab: the chat as the primary surface, with its required plain-form fallback.
// ---------------------------------------------------------------------------------------

/** The minimal slice of `UseAssistantChatResult` this tab actually renders -- kept as its
 * own type so the fallback-form behaviour can be unit-tested with a plain fake, the same
 * way `AlertsPage.test.ts` drives `AlertsPage` with a hand-built snapshot. */
export interface ClientAssistantChatLike {
  readonly messages: ReturnType<typeof useAssistantChat>['messages'];
  readonly operations: ReturnType<typeof useAssistantChat>['operations'];
  readonly handoffStatus: ReturnType<typeof useAssistantChat>['handoffStatus'];
  readonly activity: string | null;
  readonly loading: boolean;
  readonly sending: boolean;
  readonly error: string | null;
  readonly unavailable: ReturnType<typeof useAssistantChat>['unavailable'];
  readonly quota: ReturnType<typeof useAssistantChat>['quota'];
  readonly runState: ReturnType<typeof useAssistantChat>['runState'];
  readonly sendMessage: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly applyOperation: (operationId: string) => Promise<void>;
  readonly cancelOperation: (operationId: string) => Promise<void>;
}

export function ClientAssistantTab({
  chat,
  fallbackForm,
}: {
  readonly chat: ClientAssistantChatLike;
  readonly fallbackForm: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const canSend = !chat.sending && chat.unavailable !== 'auth';

  function submit() {
    const text = draft;
    if (text.trim().length === 0) return;
    setDraft('');
    void chat.sendMessage(text);
  }

  return (
    <div className="space-y-4">
      <section className="flex h-[28rem] flex-col overflow-hidden rounded-2xl border border-line bg-white">
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {chat.loading && <p className="text-sm text-muted">Загружаем диалог…</p>}
          {!chat.loading && chat.messages.length === 0 && (
            <p className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
              Задайте вопрос ассистенту — например, о статусе вашей заявки.
            </p>
          )}
          {chat.messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              operations={chat.operations}
              disabled={chat.sending}
              onApplyOperation={(operationId) => void chat.applyOperation(operationId)}
              onCancelOperation={(operationId) => void chat.cancelOperation(operationId)}
            />
          ))}
          {chat.activity && (
            <p className="px-1 text-xs text-muted" aria-live="polite">
              {chat.activity}
            </p>
          )}
        </div>
        <div className="shrink-0 space-y-2 border-t border-line p-3">
          <HandoffBanner status={chat.handoffStatus} />
          {chat.error && (
            <p role="alert" className="text-xs text-muted">
              {chat.error}
            </p>
          )}
          {chat.unavailable && (
            <AiUnavailablePanel reason={chat.unavailable} quotaResetAt={chat.quota?.resetAt} />
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              disabled={!canSend}
              rows={1}
              placeholder="Напишите сообщение…"
              className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-sm disabled:opacity-50"
            />
            {chat.runState === 'running' ? (
              <button
                type="button"
                onClick={() => void chat.stop()}
                className="shrink-0 rounded-full border border-line bg-white px-4 py-2 text-sm"
              >
                Остановить
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend || draft.trim().length === 0}
                className="shrink-0 rounded-full bg-bee px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
              >
                Отправить
              </button>
            )}
          </div>
        </div>
      </section>

      {chat.unavailable ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">
            Ассистент сейчас недоступен — оформите заявку формой ниже.
          </p>
          {fallbackForm}
        </div>
      ) : (
        <details className="rounded-2xl border border-dashed border-line bg-white p-4 text-sm">
          <summary className="cursor-pointer font-semibold">Оформить заявку без ассистента</summary>
          <div className="mt-3">{fallbackForm}</div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Routing helpers and small hooks.
// ---------------------------------------------------------------------------------------

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function parseClientPath(pathname: string): ClientTab {
  const trimmed = pathname.replace(/\/+$/, '') || '/client';
  if (trimmed === '/client/new') return 'new';
  if (trimmed === '/client/assistant') return 'assistant';
  return 'requests';
}

export function hrefForClientTab(tab: ClientTab): string {
  if (tab === 'new') return '/client/new';
  if (tab === 'assistant') return '/client/assistant';
  return '/client';
}
