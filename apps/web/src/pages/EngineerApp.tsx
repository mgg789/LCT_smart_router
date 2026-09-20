import { Menu } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardApiError } from '../api/client';
import {
  confirmEngineerEmailChange,
  loadEngineerDay,
  loadEngineerPlan,
  loadEngineerProfile,
  loadEngineerRequest,
  recordEngineerAttendance,
  requestEngineerEmailChange,
  requestEngineerLoginCode,
  signOutEngineer,
  updateEngineerProfile,
  verifyEngineerLoginCode,
} from '../api/engineer';
import type {
  EngineerDayView,
  EngineerPlanResponse,
  EngineerView,
  PlanStopView,
  RequestView,
} from '../api/types';
import { EngineerMap } from '../components/engineer/EngineerMap';
import { formatWindow, formatWindowCountdown } from '../engineer/format';
import { mapsDirectionsUrl } from '../engineer/maps';
import {
  clearEngineerSession,
  readEngineerSession,
  writeEngineerSession,
} from '../engineer/session';
import { skillLabel } from '../lib/reasons';
import { formatClock } from '../lib/time';

type EngineerPath =
  | { readonly name: 'list' }
  | { readonly name: 'route' }
  | { readonly name: 'settings' }
  | {
      readonly name: 'request';
      readonly requestId: string;
    };

/** Engineer App shell: email-code login, day list, one-stop map, settings. */
export function EngineerApp() {
  const [path, setPath] = useState<EngineerPath>(() => parseEngineerPath(window.location.pathname));
  const [token, setToken] = useState<string | null>(
    () => readEngineerSession(window.localStorage)?.token ?? null,
  );
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onPop = () => setPath(parseEngineerPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: EngineerPath) => {
    const href = hrefFor(next);
    if (window.location.pathname !== href) {
      window.history.pushState({}, '', href);
    }
    setPath(next);
    setMenuOpen(false);
  }, []);

  const onSignedIn = useCallback(
    (nextToken: string, expiresAt: number) => {
      writeEngineerSession(window.localStorage, { token: nextToken, expiresAt });
      setToken(nextToken);
      navigate({ name: 'list' });
    },
    [navigate],
  );

  const onSignedOut = useCallback(async () => {
    if (token) {
      try {
        await signOutEngineer(token);
      } catch {
        // Local sign-out still proceeds: the device must forget the token even if the
        // revoke call cannot reach the API.
      }
    }
    clearEngineerSession(window.localStorage);
    setToken(null);
    setMenuOpen(false);
    navigate({ name: 'list' });
  }, [navigate, token]);

  if (token === null) {
    return <EngineerLoginPage onSignedIn={onSignedIn} />;
  }

  return (
    <EngineerSignedIn
      token={token}
      path={path}
      menuOpen={menuOpen}
      setMenuOpen={setMenuOpen}
      navigate={navigate}
      onSignedOut={() => void onSignedOut()}
      onSessionExpired={() => {
        clearEngineerSession(window.localStorage);
        setToken(null);
      }}
    />
  );
}

function EngineerSignedIn({
  token,
  path,
  menuOpen,
  setMenuOpen,
  navigate,
  onSignedOut,
  onSessionExpired,
}: {
  readonly token: string;
  readonly path: EngineerPath;
  readonly menuOpen: boolean;
  readonly setMenuOpen: (open: boolean) => void;
  readonly navigate: (path: EngineerPath) => void;
  readonly onSignedOut: () => void;
  readonly onSessionExpired: () => void;
}) {
  const [profile, setProfile] = useState<EngineerView | null>(null);
  const [day, setDay] = useState<EngineerDayView | null>(null);
  const [plan, setPlan] = useState<EngineerPlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingIn, setCheckingIn] = useState(false);
  const [attendanceError, setAttendanceError] = useState<string | null>(null);
  const checkInOperation = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextProfile, nextDay, nextPlan] = await Promise.all([
        loadEngineerProfile(token),
        loadEngineerDay(token),
        loadEngineerPlan(token),
      ]);
      setProfile(nextProfile);
      setDay(nextDay);
      setPlan(nextPlan);
    } catch (cause) {
      if (cause instanceof DashboardApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить день');
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flex min-h-full flex-col bg-canvas text-ink">
      <header className="relative flex items-center justify-between border-b border-line bg-white px-4 py-3">
        <button
          type="button"
          onClick={() => navigate({ name: 'list' })}
          className="flex items-center gap-2"
        >
          <img src="/beeline-symbol.png" alt="Beeline" className="h-8 w-8" />
          <span className="text-sm font-semibold">Инженер</span>
        </button>
        <button
          type="button"
          aria-label="Меню"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
          className="rounded-full p-2"
        >
          <Menu className="h-6 w-6" />
        </button>
        {menuOpen ? (
          <nav className="absolute right-3 top-14 z-20 w-64 rounded-2xl border border-line bg-white p-2 shadow-sm">
            <p className="px-3 py-2 text-sm font-semibold">{profile?.displayName ?? '…'}</p>
            <MenuButton label="Маршрут на день" onClick={() => navigate({ name: 'route' })} />
            <p className="px-3 py-2 text-sm text-muted">Поддержка</p>
            <MenuButton label="Настройки" onClick={() => navigate({ name: 'settings' })} />
            <MenuButton label="Выйти" onClick={onSignedOut} />
          </nav>
        ) : null}
      </header>

      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-4">
        {day && (
          <section className="mb-4 rounded-2xl bg-white p-4">
            <button
              type="button"
              disabled={checkingIn}
              onClick={async () => {
                setCheckingIn(true);
                setAttendanceError(null);
                checkInOperation.current ??= crypto.randomUUID();
                try {
                  setDay(await recordEngineerAttendance(token, checkInOperation.current));
                  checkInOperation.current = null;
                } catch (cause) {
                  setAttendanceError(
                    cause instanceof Error ? cause.message : 'Не удалось сохранить отметку',
                  );
                } finally {
                  setCheckingIn(false);
                }
              }}
              className="rounded-full bg-bee px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {checkingIn
                ? 'Сохраняем…'
                : day.lastAttendanceAt
                  ? 'Я на связи — отметиться'
                  : 'Я вышел на смену'}
            </button>
            {day.lastAttendanceAt && (
              <p className="mt-2 text-xs text-muted">
                Последняя отметка: {formatClock(day.lastAttendanceAt)}
              </p>
            )}
            {attendanceError && (
              <p role="alert" className="mt-2 text-sm">
                {attendanceError}
              </p>
            )}
          </section>
        )}
        {loading && profile === null ? (
          <p className="text-sm text-muted">Загружаем смену…</p>
        ) : error && profile === null ? (
          <div className="rounded-2xl bg-white p-4 text-sm">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void reload()}
              className="mt-3 rounded-full bg-bee px-4 py-2 font-semibold"
            >
              Повторить
            </button>
          </div>
        ) : path.name === 'settings' && profile ? (
          <EngineerSettingsPage
            token={token}
            profile={profile}
            onProfile={setProfile}
            onSessionExpired={onSessionExpired}
          />
        ) : path.name === 'route' && plan && profile ? (
          <EngineerRoutePage plan={plan} profile={profile} />
        ) : path.name === 'request' && profile ? (
          <EngineerRequestPage
            token={token}
            requestId={path.requestId}
            profile={profile}
            plan={plan}
            onBack={() => navigate({ name: 'list' })}
            onSessionExpired={onSessionExpired}
          />
        ) : (
          <EngineerDayPage
            profile={profile}
            day={day}
            plan={plan}
            error={error}
            onOpenRequest={(requestId) => navigate({ name: 'request', requestId })}
          />
        )}
      </main>
    </div>
  );
}

function EngineerLoginPage({
  onSignedIn,
}: {
  readonly onSignedIn: (token: string, expiresAt: number) => void;
}) {
  const [email, setEmail] = useState(
    () => new URLSearchParams(window.location.search).get('email') ?? '',
  );
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<{ email: string; devCode?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const issuedCode = await requestEngineerLoginCode(email);
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
      const session = await verifyEngineerLoginCode(issued.email, code);
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
        <h1 className="mt-4 text-center text-xl font-semibold">Вход инженера</h1>
        <p className="mt-2 text-center text-sm text-muted">
          Почта бригады и код из письма. Роль выдаёт диспетчер, ввод адреса сам её не создаёт.
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

function EngineerDayPage({
  profile,
  day,
  plan,
  error,
  onOpenRequest,
}: {
  readonly profile: EngineerView | null;
  readonly day: EngineerDayView | null;
  readonly plan: EngineerPlanResponse | null;
  readonly error: string | null;
  readonly onOpenRequest: (requestId: string) => void;
}) {
  const nowAt = Math.floor(Date.now() / 1000);
  const items = useMemo(() => dayItems(plan), [plan]);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm text-muted">
          Смена{' '}
          {day
            ? `${formatClock(day.shiftStartAt)}–${formatClock(day.shiftEndAt)}`
            : 'ещё не открыта'}
        </p>
        <h1 className="text-xl font-semibold">{profile?.displayName ?? 'Бригада'}</h1>
      </div>
      {error ? (
        <p className="rounded-2xl bg-white px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line bg-white p-6 text-center text-sm text-muted">
          На сегодня нет назначенных заявок.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((item) =>
            item.kind === 'lunch' ? (
              <li
                key={`lunch-${item.stop.sequence}`}
                className="rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-4"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-amber-800">Обед</p>
                <p className="mt-1 font-semibold">Перерыв</p>
                <p className="mt-1 text-sm text-muted">
                  {formatClock(item.stop.startAt)}–{formatClock(item.stop.endAt)}
                </p>
              </li>
            ) : (
              <li key={item.request.id}>
                <RequestCard
                  request={item.request}
                  stop={item.stop}
                  transport={profile?.transportType ?? 'car'}
                  nowAt={nowAt}
                  onOpen={() => onOpenRequest(item.request.id)}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function EngineerRequestPage({
  token,
  requestId,
  profile,
  plan,
  onBack,
  onSessionExpired,
}: {
  readonly token: string;
  readonly requestId: string;
  readonly profile: EngineerView;
  readonly plan: EngineerPlanResponse | null;
  readonly onBack: () => void;
  readonly onSessionExpired: () => void;
}) {
  const fromPlan = plan?.requests.find((request) => request.id === requestId) ?? null;
  const stopFromPlan = plan?.route?.stops.find((stop) => stop.requestId === requestId) ?? null;
  const [request, setRequest] = useState<RequestView | null>(fromPlan);
  const [stop, setStop] = useState<PlanStopView | null>(stopFromPlan);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fromPlan && stopFromPlan) {
      setRequest(fromPlan);
      setStop(stopFromPlan);
      return;
    }
    let cancelled = false;
    void loadEngineerRequest(token, requestId)
      .then((loaded) => {
        if (cancelled) return;
        setRequest(loaded.request);
        setStop(loaded.stop);
      })
      .catch((cause) => {
        if (cancelled) return;
        if (cause instanceof DashboardApiError && cause.status === 401) {
          onSessionExpired();
          return;
        }
        setError(cause instanceof Error ? cause.message : 'Заявка недоступна');
      });
    return () => {
      cancelled = true;
    };
  }, [fromPlan, onSessionExpired, requestId, stopFromPlan, token]);

  if (error) {
    return (
      <div>
        <button type="button" onClick={onBack} className="text-sm text-muted">
          ← К списку
        </button>
        <p className="mt-4 text-sm">{error}</p>
      </div>
    );
  }
  if (!request || !stop) {
    return <p className="text-sm text-muted">Открываем заявку…</p>;
  }

  const nowAt = Math.floor(Date.now() / 1000);
  const markers =
    request.lat !== null && request.lon !== null
      ? [
          {
            id: request.id,
            lat: request.lat,
            lon: request.lon,
            kind: 'job' as const,
            label: request.addressText,
          },
        ]
      : [];

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm text-muted">
        ← К списку
      </button>
      <RequestDetails request={request} stop={stop} nowAt={nowAt} />
      {markers.length > 0 ? (
        <EngineerMap markers={markers} line={[]} />
      ) : (
        <p className="rounded-2xl bg-white p-4 text-sm text-muted">
          Координаты заявки ещё не известны.
        </p>
      )}
      {request.lat !== null && request.lon !== null ? (
        <a
          href={mapsDirectionsUrl(request.lat, request.lon, profile.transportType)}
          className="block rounded-full bg-bee py-3 text-center text-sm font-semibold"
        >
          Маршрут в картах
        </a>
      ) : null}
    </div>
  );
}

function EngineerRoutePage({
  plan,
  profile,
}: {
  readonly plan: EngineerPlanResponse;
  readonly profile: EngineerView;
}) {
  const route = plan.route;
  const markers = (route?.stops ?? [])
    .filter((stop) => stop.kind === 'job' || stop.kind === 'lunch' || stop.kind === 'start')
    .map((stop) => ({
      id: `${stop.kind}-${stop.sequence}`,
      lat: stop.lat,
      lon: stop.lon,
      kind:
        stop.kind === 'lunch'
          ? ('lunch' as const)
          : stop.kind === 'start'
            ? ('start' as const)
            : ('job' as const),
      label: stop.requestId ?? stop.kind,
    }));
  const line =
    route?.legs.flatMap((leg) => leg.geometry?.points ?? []) ??
    (route?.stops ?? []).map((stop) => ({ lat: stop.lat, lon: stop.lon }));

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted">{profile.displayName}</p>
        <h1 className="text-xl font-semibold">Маршрут на день</h1>
      </div>
      {markers.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line bg-white p-6 text-sm text-muted">
          Применённого маршрута пока нет.
        </p>
      ) : (
        <EngineerMap markers={markers} line={line} />
      )}
    </div>
  );
}

function EngineerSettingsPage({
  token,
  profile,
  onProfile,
  onSessionExpired,
}: {
  readonly token: string;
  readonly profile: EngineerView;
  readonly onProfile: (profile: EngineerView) => void;
  readonly onSessionExpired: () => void;
}) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [transportType, setTransportType] = useState(profile.transportType);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [issued, setIssued] = useState<{ email: string; devCode?: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (cause: unknown) => {
    if (cause instanceof DashboardApiError && cause.status === 401) {
      onSessionExpired();
      return;
    }
    setError(cause instanceof Error ? cause.message : 'Не удалось сохранить');
  };

  const saveProfile = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await updateEngineerProfile(token, {
        expectedVersion: profile.version,
        displayName,
        transportType,
      });
      onProfile(next);
      setMessage('Профиль обновлён');
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const requestEmail = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await requestEngineerEmailChange(token, email);
      setIssued({ email: next.email, ...(next.devCode ? { devCode: next.devCode } : {}) });
      setMessage('Код отправлен на новый адрес');
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const confirmEmail = async () => {
    if (issued === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await confirmEngineerEmailChange(token, issued.email, code);
      onProfile(next);
      setIssued(null);
      setEmail('');
      setCode('');
      setMessage('Почта входа обновлена');
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Настройки</h1>
      <section className="space-y-3 rounded-2xl bg-white p-4">
        <p className="text-sm text-muted">Текущая почта входа: {profile.email ?? 'не задана'}</p>
        <label className="block text-sm">
          Новая почта
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-2xl border border-line px-3 py-2"
          />
        </label>
        {issued ? (
          <label className="block text-sm">
            Код подтверждения
            <input
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              className="mt-1 w-full rounded-2xl border border-line px-3 py-2"
            />
          </label>
        ) : null}
        {issued?.devCode ? (
          <p className="text-xs text-muted">Код для локальной отладки: {issued.devCode}</p>
        ) : null}
        <button
          type="button"
          disabled={busy || email.length === 0}
          onClick={() => void (issued ? confirmEmail() : requestEmail())}
          className="rounded-full bg-bee px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {issued ? 'Подтвердить почту' : 'Отправить код'}
        </button>
      </section>

      <section className="space-y-3 rounded-2xl bg-white p-4">
        <label className="block text-sm">
          Имя
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className="mt-1 w-full rounded-2xl border border-line px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          Транспорт бригады
          <select
            value={transportType}
            onChange={(event) =>
              setTransportType(event.target.value as EngineerView['transportType'])
            }
            className="mt-1 w-full rounded-2xl border border-line px-3 py-2"
          >
            <option value="car">Автомобиль</option>
            <option value="walk">Пешком</option>
            <option value="bike">Велосипед</option>
            <option value="transit">Общественный транспорт</option>
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void saveProfile()}
          className="rounded-full bg-bee px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Сохранить профиль
        </button>
      </section>
      {message ? <p className="text-sm">{message}</p> : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

function RequestCard({
  request,
  stop,
  transport,
  nowAt,
  onOpen,
}: {
  readonly request: RequestView;
  readonly stop: PlanStopView;
  readonly transport: EngineerView['transportType'];
  readonly nowAt: number;
  readonly onOpen: () => void;
}) {
  return (
    <article className="rounded-2xl border border-line bg-white p-4">
      <button type="button" onClick={onOpen} className="w-full text-left">
        <RequestDetails request={request} stop={stop} nowAt={nowAt} />
      </button>
      {request.lat !== null && request.lon !== null ? (
        <a
          href={mapsDirectionsUrl(request.lat, request.lon, transport)}
          className="mt-3 block rounded-full bg-bee py-2 text-center text-sm font-semibold"
        >
          Маршрут в картах
        </a>
      ) : null}
    </article>
  );
}

function RequestDetails({
  request,
  stop,
  nowAt,
}: {
  readonly request: RequestView;
  readonly stop: PlanStopView;
  readonly nowAt: number;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {request.workTypeTitle ?? skillLabel(request.requiredSkill)}
        </p>
        {request.priority === 'urgent' ? (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] text-red-800">
            срочно
          </span>
        ) : null}
      </div>
      <h2 className="mt-1 font-semibold">{request.addressText}</h2>
      <p className="mt-1 text-sm text-muted">
        Окно {formatWindow(request.windowStartAt, request.windowEndAt)} · план{' '}
        {formatClock(stop.startAt)}–{formatClock(stop.endAt)}
      </p>
      <p className="mt-1 text-sm">
        {formatWindowCountdown(nowAt, request.windowStartAt, request.windowEndAt)}
      </p>
      {request.contactName ? <p className="mt-2 text-sm">Клиент: {request.contactName}</p> : null}
      {request.problemText ? (
        <p className="mt-1 text-sm text-muted">{request.problemText}</p>
      ) : null}
    </div>
  );
}

function MenuButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-canvas"
    >
      {label}
    </button>
  );
}

type DayItem =
  | { readonly kind: 'job'; readonly stop: PlanStopView; readonly request: RequestView }
  | { readonly kind: 'lunch'; readonly stop: PlanStopView };

function dayItems(plan: EngineerPlanResponse | null): DayItem[] {
  if (plan?.route === null || plan === null) {
    return [];
  }
  const byId = new Map(plan.requests.map((request) => [request.id, request]));
  const items: DayItem[] = [];
  for (const stop of plan.route.stops) {
    if (stop.kind === 'lunch') {
      items.push({ kind: 'lunch', stop });
      continue;
    }
    if (stop.kind !== 'job' || stop.requestId === null) {
      continue;
    }
    const request = byId.get(stop.requestId);
    if (request) {
      items.push({ kind: 'job', stop, request });
    }
  }
  return items;
}

function parseEngineerPath(pathname: string): EngineerPath {
  const trimmed = pathname.replace(/\/+$/, '') || '/engineer';
  if (trimmed === '/engineer/route') return { name: 'route' };
  if (trimmed === '/engineer/settings') return { name: 'settings' };
  const requestMatch = /^\/engineer\/requests\/([^/]+)$/.exec(trimmed);
  if (requestMatch?.[1]) {
    return { name: 'request', requestId: decodeURIComponent(requestMatch[1]) };
  }
  return { name: 'list' };
}

function hrefFor(path: EngineerPath): string {
  const params = new URLSearchParams(window.location.search);
  const search = params.toString() ? `?${params.toString()}` : '';
  if (path.name === 'route') return `/engineer/route${search}`;
  if (path.name === 'settings') return `/engineer/settings${search}`;
  if (path.name === 'request')
    return `/engineer/requests/${encodeURIComponent(path.requestId)}${search}`;
  return `/engineer${search}`;
}
