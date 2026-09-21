import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardApiError } from '../api/client';
import {
  loadEngineerDay,
  loadEngineerPlan,
  loadEngineerProfile,
  loadEngineerRequest,
  updateEngineerProfile,
} from '../api/engineer';
import {
  type EngineerLiveAction,
  type EngineerLiveView,
  sendEngineerLiveAction,
} from '../api/live';
import type { EngineerDayView, EngineerPlanResponse, EngineerView } from '../api/types';
import { TRANSPORT_OPTIONS } from '../figma-dashboard/addEntity';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { ENGINEER_ASSETS } from './assets';
import {
  DESIGN_PREVIEW_DAY,
  DESIGN_PREVIEW_NOW_MS,
  DESIGN_PREVIEW_PLAN,
  DESIGN_PREVIEW_PROFILE,
} from './designPreview';
import { EngineerMenu, type EngineerMenuId } from './EngineerMenu';
import { EngineerSettings } from './EngineerSettings';
import { engineerHeaderStamp } from './engineerClock';
import type { EngineerJobItem } from './engineerDay';
import { engineerListItems, engineerLunchWindow, missingRequestIds } from './engineerDay';
import { engineerMapsUrl } from './engineerRoute';
import { eu } from './engineerScale';
import { LiveControls, LiveDayOverlay } from './LiveControls';
import { loadEngineerSessionLive } from './liveSession';
import { EngineerListCard } from './RequestCards';
import { RequestDetail } from './RequestDetail';
import {
  type EngineerSettingsDraft,
  emailChangePending,
  profileFromSettings,
} from './settingsDraft';

const slideEase = [0.22, 1, 0.36, 1] as const;
const slide = { duration: 0.34, ease: slideEase };

/**
 * Signed-in Engineer App: Figma list 73:9536, left menu 72:9315.
 * Profile / day / plan come from the engineer contour; missing request
 * cards are filled from `GET /engineer/requests/:id`.
 */
export function EngineerApp({
  token,
  fallbackEmail,
  onSignOut,
  onSessionExpired,
  designPreview = false,
}: {
  token: string;
  fallbackEmail: string;
  onSignOut: () => void;
  onSessionExpired: () => void;
  designPreview?: boolean;
}) {
  const motionOn = !useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const [screen, setScreen] = useState<EngineerMenuId>('day');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [profile, setProfile] = useState<EngineerView | null>(
    designPreview ? DESIGN_PREVIEW_PROFILE : null,
  );
  const [day, setDay] = useState<EngineerDayView | null>(designPreview ? DESIGN_PREVIEW_DAY : null);
  const [storedPlan, setStoredPlan] = useState<EngineerPlanResponse | null>(
    designPreview ? DESIGN_PREVIEW_PLAN : null,
  );
  const [live, setLive] = useState<EngineerLiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!designPreview);
  const [openedJob, setOpenedJob] = useState<EngineerJobItem | null>(null);
  const [startPendingId, setStartPendingId] = useState<string | null>(null);
  const [breakPending, setBreakPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsSubmitting, setSettingsSubmitting] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const liveActionPending = useRef(false);
  const readPending = useRef(false);
  const requestGeneration = useRef(0);
  const liveReceivedAt = useRef(Date.now());
  const [actionBusy, setActionBusy] = useState(false);
  const acceptLive = useCallback((value: EngineerLiveView, receivedAt = Date.now()) => {
    liveReceivedAt.current = receivedAt;
    setLive(value);
  }, []);
  const logicalNow = live
    ? Math.floor(
        live.workday.liveNow +
          (live.workday.status === 'running'
            ? (Math.max(0, nowMs - liveReceivedAt.current) / 1000) * live.workday.speedFactor
            : 0),
      )
    : Math.floor(nowMs / 1000);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const failSession = useCallback(
    (cause: unknown) => {
      if (cause instanceof DashboardApiError && cause.status === 401) {
        onSessionExpired();
        return true;
      }
      return false;
    },
    [onSessionExpired],
  );

  const reload = useCallback(
    async (initial = false) => {
      if (designPreview) {
        setProfile(DESIGN_PREVIEW_PROFILE);
        setDay(DESIGN_PREVIEW_DAY);
        setStoredPlan(DESIGN_PREVIEW_PLAN);
        setLoading(false);
        return;
      }
      if (readPending.current || liveActionPending.current) return;
      readPending.current = true;
      const generation = requestGeneration.current;
      if (initial) setLoading(true);
      setError(null);
      try {
        const [nextProfile, nextDay, nextPlan, nextLive] = await Promise.all([
          loadEngineerProfile(token),
          loadEngineerDay(token),
          loadEngineerPlan(token),
          loadEngineerSessionLive(token),
        ]);
        const missing = missingRequestIds(nextPlan);
        const extras = await Promise.all(
          missing.map((id) => loadEngineerRequest(token, id).then((body) => body.request)),
        );
        if (generation !== requestGeneration.current) return;
        setStoredPlan({ ...nextPlan, requests: [...nextPlan.requests, ...extras] });
        setProfile(nextProfile);
        setDay(nextDay);
        acceptLive(nextLive);
      } catch (cause) {
        if (failSession(cause)) return;
        setError(cause instanceof Error ? cause.message : 'Не удалось загрузить смену');
      } finally {
        readPending.current = false;
        if (initial) setLoading(false);
      }
    },
    [acceptLive, designPreview, failSession, token],
  );

  useEffect(() => {
    void reload(true);
  }, [reload]);

  useEffect(() => {
    if (designPreview) return;
    let disposed = false;
    const refreshLive = async () => {
      if (liveActionPending.current || readPending.current) return;
      readPending.current = true;
      const generation = requestGeneration.current;
      try {
        const next = await loadEngineerSessionLive(token);
        const receivedAt = Date.now();
        const nextPlan = await loadEngineerPlan(token);
        const extras = await Promise.all(
          missingRequestIds(nextPlan).map((id) =>
            loadEngineerRequest(token, id).then((body) => body.request),
          ),
        );
        if (disposed || generation !== requestGeneration.current) return;
        setStoredPlan({ ...nextPlan, requests: [...nextPlan.requests, ...extras] });
        acceptLive(next, receivedAt);
        setError(null);
      } catch (cause) {
        if (disposed || generation !== requestGeneration.current) return;
        if (!failSession(cause)) {
          setError(cause instanceof Error ? cause.message : 'Не удалось обновить статус смены');
        }
      } finally {
        readPending.current = false;
      }
    };
    const timer = window.setInterval(() => void refreshLive(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [acceptLive, designPreview, failSession, token]);

  const plan = useMemo<EngineerPlanResponse | null>(() => {
    if (!storedPlan || !live || live.workday.status === 'pending') return storedPlan;
    const current = live.current?.request;
    return {
      ...storedPlan,
      route: live.route,
      requests: current
        ? [...storedPlan.requests.filter((request) => request.id !== current.id), current]
        : storedPlan.requests,
    };
  }, [live, storedPlan]);

  const lunch = useMemo(() => {
    const actual = live?.lunch
      ? { startAt: live.lunch.startedAt, endAt: live.lunch.endAt }
      : live?.engineer.lunchInterval;
    const planned = engineerLunchWindow(plan, live ? null : day, actual);
    return planned && (!live || planned.endAt > logicalNow) ? planned : null;
  }, [day, live, logicalNow, plan]);

  const items = useMemo(
    () =>
      engineerListItems(plan, live ? null : day, lunch)
        .filter((item) =>
          item.kind === 'lunch'
            ? !live || item.endAt > logicalNow
            : item.request.lifecycle !== 'completed' &&
              item.request.lifecycle !== 'cancelled' &&
              (!item.request.assumedCompletedAt || live?.engineer.stats.completedCount === 0),
        )
        .map((item) =>
          item.kind === 'job' && live
            ? {
                ...item,
                variant:
                  item.request.id === live.current?.request.id
                    ? ('upcoming' as const)
                    : ('regular' as const),
              }
            : item,
        ),
    [day, live, logicalNow, plan, lunch],
  );

  const applyLiveAction = async (action: EngineerLiveAction): Promise<boolean> => {
    if (liveActionPending.current) return false;
    liveActionPending.current = true;
    requestGeneration.current += 1;
    setActionBusy(true);
    try {
      const next = await sendEngineerLiveAction(token, action);
      const receivedAt = Date.now();
      setError(null);
      const terminalId =
        action.kind === 'finish' || (action.kind === 'problem' && action.problemKind !== 'delay')
          ? action.requestId
          : null;
      try {
        const nextPlan = await loadEngineerPlan(token);
        const extras = await Promise.all(
          missingRequestIds(nextPlan).map((id) =>
            loadEngineerRequest(token, id).then((body) => body.request),
          ),
        );
        setStoredPlan({ ...nextPlan, requests: [...nextPlan.requests, ...extras] });
      } catch (cause) {
        // The fact is already committed: do not invite a duplicate mutation if only
        // the follow-up read failed. Preserve its terminal state until polling recovers.
        if (terminalId)
          setStoredPlan((previous) =>
            previous
              ? {
                  ...previous,
                  requests: previous.requests.map((request) =>
                    request.id !== terminalId
                      ? request
                      : action.kind === 'finish'
                        ? {
                            ...request,
                            lifecycle: 'completed',
                            assignmentState: 'done',
                            completedAt: next.workday.liveNow,
                          }
                        : { ...request, lifecycle: 'cancelled', cancelledAt: next.workday.liveNow },
                  ),
                }
              : previous,
          );
        if (!failSession(cause))
          setError('Отметка сохранена. Не удалось обновить маршрут — повторим автоматически.');
      }
      if (terminalId)
        setOpenedJob((previous) => (previous?.request.id === terminalId ? null : previous));
      acceptLive(next, receivedAt);
      return true;
    } catch (cause) {
      if (failSession(cause)) return false;
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить отметку');
      return false;
    } finally {
      liveActionPending.current = false;
      setActionBusy(false);
    }
  };

  const startJob = async (requestId: string) => {
    if (designPreview) {
      setNotice('В макете факт «приступить» не отправляется.');
      return;
    }
    setStartPendingId(requestId);
    setNotice(null);
    try {
      await applyLiveAction({ kind: 'start', requestId });
    } finally {
      setStartPendingId(null);
    }
  };

  const openRoute = (job: EngineerJobItem) => {
    const url = engineerMapsUrl({
      lat: job.request.lat ?? job.stop.lat,
      lon: job.request.lon ?? job.stop.lon,
      addressText: job.request.addressText,
    });
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const startBreak = async () => {
    if (designPreview) {
      setNotice('В макете технический перерыв не отправляется.');
      setMenuOpen(false);
      return;
    }
    setBreakPending(true);
    setNotice(null);
    try {
      const kind = live?.engineer.technicalBreak ? 'break_finish' : 'break_start';
      if (await applyLiveAction({ kind })) {
        setNotice(null);
        setMenuOpen(false);
      }
    } finally {
      setBreakPending(false);
    }
  };

  const saveSettings = async (draft: EngineerSettingsDraft) => {
    if (!profile) return;
    setSettingsError(null);
    if (designPreview) {
      setProfile(profileFromSettings(profile, draft));
      setNotice(
        emailChangePending(profile.email ?? fallbackEmail, draft.email)
          ? 'Имя и транспорт сохранены в макете. Смена почты здесь только локально — PATCH /engineer/profile почту не принимает.'
          : 'Профиль обновлён в макете.',
      );
      setScreen('day');
      return;
    }
    const transport = TRANSPORT_OPTIONS.find((item) => item.id === draft.transportType);
    if (!transport) return;
    setSettingsSubmitting(true);
    try {
      const next = await updateEngineerProfile(token, {
        expectedVersion: profile.version,
        displayName: draft.displayName.trim(),
        transportType: transport.id,
      });
      setProfile(next);
      setNotice(
        emailChangePending(profile.email ?? fallbackEmail, draft.email)
          ? 'Имя и транспорт сохранены. Смена почты через PATCH /engineer/profile ещё не доступна.'
          : 'Профиль сохранён.',
      );
      setScreen('day');
    } catch (cause) {
      if (failSession(cause)) return;
      setSettingsError(cause instanceof Error ? cause.message : 'Не удалось сохранить профиль');
    } finally {
      setSettingsSubmitting(false);
    }
  };

  const name = profile?.displayName ?? 'Инженер';
  const detailJob = openedJob
    ? (items.find(
        (item): item is EngineerJobItem =>
          item.kind === 'job' && item.request.id === openedJob.request.id,
      ) ?? null)
    : null;
  const controls = (id: string, detail = false) =>
    live?.current?.request.id === id ? (
      <LiveControls
        key={id}
        live={live}
        now={logicalNow}
        busy={actionBusy}
        send={applyLiveAction}
        detail={detail}
      />
    ) : null;
  const email = profile?.email ?? fallbackEmail;
  const overlayOpen = detailJob !== null || screen === 'settings';
  const sheetY = window.innerHeight;

  return (
    <main className="min-h-full overflow-x-hidden bg-figma-canvas">
      <div className="engineer-phone relative h-dvh overflow-hidden">
        <div
          className="flex h-full min-h-0 flex-col overflow-y-auto"
          style={{ padding: `${eu(36)} ${eu(40)} ${eu(40)}` }}
        >
          <header className="flex items-center" style={{ gap: eu(20) }}>
            <motion.button
              type="button"
              aria-label="Меню"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
              whileTap={{ scale: 0.96 }}
              transition={{ duration: 0.16 }}
              className="flex shrink-0 items-center justify-center overflow-hidden bg-figma-ink"
              style={{
                width: eu(90),
                height: eu(90),
                borderRadius: eu(20),
              }}
            >
              <FigmaIcon
                src={ENGINEER_ASSETS.menu}
                alt=""
                width={36}
                height={25}
                style={{ width: eu(36), height: eu(25) }}
              />
            </motion.button>
            <p
              className="min-w-0 font-murs tracking-[-0.02em] text-figma-ink"
              style={{ fontSize: eu(32), position: 'relative', top: 2 }}
            >
              {engineerHeaderStamp(live ? logicalNow * 1000 : nowMs)}
            </p>
          </header>

          {screen !== 'assistant' ? (
            <>
              <h1
                className="font-extrabold tracking-[0.02em] text-figma-ink"
                style={{ marginTop: eu(48), fontSize: eu(36) }}
              >
                Список заявок
              </h1>
              {notice ? (
                <p
                  className="font-medium text-figma-muted"
                  style={{ marginTop: eu(16), fontSize: eu(16), lineHeight: eu(22) }}
                >
                  {notice}
                </p>
              ) : null}
              {error ? (
                <div
                  className="bg-white"
                  style={{
                    marginTop: eu(20),
                    borderRadius: eu(20),
                    padding: eu(24),
                  }}
                >
                  <p className="font-semibold text-figma-ink" style={{ fontSize: eu(20) }}>
                    {error}
                  </p>
                  <motion.button
                    type="button"
                    onClick={() => void reload()}
                    whileTap={{ scale: 0.98 }}
                    className="bg-figma-bee font-semibold text-figma-ink"
                    style={{
                      marginTop: eu(16),
                      borderRadius: eu(20),
                      padding: `${eu(16)} ${eu(32)}`,
                      fontSize: eu(20),
                    }}
                  >
                    Повторить
                  </motion.button>
                </div>
              ) : null}
              {loading && items.length === 0 && error === null ? (
                <p
                  className="font-medium text-figma-muted"
                  style={{ marginTop: eu(24), fontSize: eu(20) }}
                >
                  Загружаем смену…
                </p>
              ) : null}
              {!loading && items.length === 0 && error === null ? (
                <div
                  className="bg-white"
                  style={{
                    marginTop: eu(20),
                    borderRadius: eu(20),
                    padding: `${eu(28)} ${eu(24)}`,
                  }}
                >
                  <p className="font-semibold text-figma-ink" style={{ fontSize: eu(24) }}>
                    {live?.engineer.canFinishDay
                      ? 'Работа на сегодня завершена'
                      : 'Ожидаем новые заявки'}
                  </p>
                  <p
                    className="font-medium text-figma-muted"
                    style={{ marginTop: eu(8), fontSize: eu(18) }}
                  >
                    {live?.engineer.canFinishDay
                      ? 'Ваши заявки завершены, можно ехать домой. Диспетчер продолжит работу с алертами.'
                      : 'До 17:00 остаёмся на связи. После 17:00 можно закончить день, когда ваша работа завершена и нет новых назначений.'}
                  </p>
                </div>
              ) : null}
              <div className="flex flex-col" style={{ marginTop: eu(20), gap: eu(20) }}>
                {items.map((item, index) => (
                  <EngineerListCard
                    key={item.kind === 'lunch' ? `lunch-${item.startAt}` : item.request.id}
                    item={item}
                    motionOn={motionOn}
                    delay={index * 0.04}
                    actions={live && item.kind === 'job' ? controls(item.request.id) : undefined}
                    startPending={item.kind === 'job' && startPendingId === item.request.id}
                    onOpen={
                      item.kind === 'job'
                        ? () => {
                            setOpenedJob(item);
                            setScreen('day');
                            setNotice(null);
                          }
                        : undefined
                    }
                    onRoute={item.kind === 'job' ? () => openRoute(item) : undefined}
                    onStart={item.kind === 'job' ? () => void startJob(item.request.id) : undefined}
                  />
                ))}
              </div>
            </>
          ) : (
            <ComingSoon
              title="Помощник"
              body="Чат с помощником появится отдельным экраном. Сейчас можно вернуться к списку заявок."
              motionOn={motionOn}
              onBack={() => setScreen('day')}
            />
          )}
        </div>

        <AnimatePresence>
          {openedJob && detailJob ? (
            <motion.div
              key={`detail-${openedJob.request.id}`}
              className="absolute left-0 top-0 z-30 h-full w-full bg-figma-canvas"
              initial={motionOn ? { x: '100%' } : false}
              animate={{ x: '0%' }}
              exit={motionOn ? { x: '100%' } : undefined}
              transition={motionOn ? slide : { duration: 0 }}
            >
              <div className="h-full overflow-y-auto">
                <RequestDetail
                  item={detailJob}
                  actions={live ? controls(detailJob.request.id, true) : undefined}
                  nowMs={designPreview ? DESIGN_PREVIEW_NOW_MS : logicalNow * 1000}
                  onBack={() => {
                    setOpenedJob(null);
                    setNotice(null);
                  }}
                  onRoute={() => openRoute(openedJob)}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {live ? (
          <LiveDayOverlay live={live} now={logicalNow} busy={actionBusy} send={applyLiveAction} />
        ) : null}
        <AnimatePresence>
          {screen === 'settings' ? (
            <motion.div
              key="settings"
              className="absolute left-0 top-0 z-30 h-full w-full bg-figma-canvas"
              initial={motionOn ? { y: sheetY } : false}
              animate={{ y: 0 }}
              exit={motionOn ? { y: sheetY } : undefined}
              transition={motionOn ? slide : { duration: 0 }}
            >
              <div className="h-full overflow-y-auto">
                {profile ? (
                  <EngineerSettings
                    profile={profile}
                    fallbackEmail={fallbackEmail}
                    submitting={settingsSubmitting}
                    saveError={settingsError}
                    onBack={() => {
                      setScreen('day');
                      setSettingsError(null);
                    }}
                    onSave={(draft) => void saveSettings(draft)}
                  />
                ) : (
                  <p
                    className="font-medium text-figma-muted"
                    style={{ padding: eu(40), fontSize: eu(20) }}
                  >
                    Загружаем профиль…
                  </p>
                )}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {overlayOpen ? null : (
          <EngineerMenu
            open={menuOpen}
            motionOn={motionOn}
            name={name}
            email={email || '—'}
            active={screen}
            lunch={lunch}
            breakActive={
              live?.engineer.technicalBreak !== null && live?.engineer.technicalBreak !== undefined
            }
            breakPending={breakPending}
            onClose={() => setMenuOpen(false)}
            onNavigate={(id) => {
              setOpenedJob(null);
              setScreen(id);
              setMenuOpen(false);
              setNotice(null);
              setSettingsError(null);
            }}
            onBreak={() => void startBreak()}
            onSupport={() => {
              setNotice('Поддержка и помощник — следующие экраны.');
              setMenuOpen(false);
            }}
            onSignOut={onSignOut}
          />
        )}
      </div>
    </main>
  );
}

function ComingSoon({
  title,
  body,
  motionOn,
  onBack,
}: {
  title: string;
  body: string;
  motionOn: boolean;
  onBack: () => void;
}) {
  return (
    <motion.section
      initial={motionOn ? { opacity: 0, y: 12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      style={{ marginTop: eu(40) }}
    >
      <h1 className="font-extrabold tracking-[0.02em] text-figma-ink" style={{ fontSize: eu(36) }}>
        {title}
      </h1>
      <p
        className="font-medium text-figma-muted"
        style={{ marginTop: eu(16), fontSize: eu(20), lineHeight: eu(28) }}
      >
        {body}
      </p>
      <motion.button
        type="button"
        onClick={onBack}
        whileTap={{ scale: 0.98 }}
        className="bg-figma-bee font-semibold text-figma-ink"
        style={{
          marginTop: eu(24),
          borderRadius: eu(20),
          padding: `${eu(18)} ${eu(32)}`,
          fontSize: eu(22),
        }}
      >
        К списку заявок
      </motion.button>
    </motion.section>
  );
}
