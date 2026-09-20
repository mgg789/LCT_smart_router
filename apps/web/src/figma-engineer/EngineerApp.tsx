import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  loadEngineerDay,
  loadEngineerPlan,
  loadEngineerProfile,
  loadEngineerRequest,
  updateEngineerProfile,
} from '../api/engineer';
import { sendEngineerLiveAction } from '../api/live';
import { DashboardApiError } from '../api/client';
import type { EngineerDayView, EngineerPlanResponse, EngineerView } from '../api/types';
import { TRANSPORT_OPTIONS } from '../figma-dashboard/addEntity';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { ENGINEER_ASSETS } from './assets';
import { engineerHeaderStamp } from './engineerClock';
import {
  engineerListItems,
  engineerLunchWindow,
  missingRequestIds,
} from './engineerDay';
import {
  DESIGN_PREVIEW_DAY,
  DESIGN_PREVIEW_NOW_MS,
  DESIGN_PREVIEW_PLAN,
  DESIGN_PREVIEW_PROFILE,
} from './designPreview';
import type { EngineerJobItem } from './engineerDay';
import { EngineerMenu, type EngineerMenuId } from './EngineerMenu';
import { engineerMapsUrl } from './engineerRoute';
import { eu } from './engineerScale';
import {
  emailChangePending,
  type EngineerSettingsDraft,
  profileFromSettings,
} from './settingsDraft';
import { EngineerSettings } from './EngineerSettings';
import { RequestDetail } from './RequestDetail';
import { EngineerListCard } from './RequestCards';

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
  const [day, setDay] = useState<EngineerDayView | null>(
    designPreview ? DESIGN_PREVIEW_DAY : null,
  );
  const [plan, setPlan] = useState<EngineerPlanResponse | null>(
    designPreview ? DESIGN_PREVIEW_PLAN : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!designPreview);
  const [openedJob, setOpenedJob] = useState<EngineerJobItem | null>(null);
  const [lateIds, setLateIds] = useState<ReadonlySet<string>>(new Set());
  const [onTimeIds, setOnTimeIds] = useState<ReadonlySet<string>>(new Set());
  const [startPendingId, setStartPendingId] = useState<string | null>(null);
  const [breakPending, setBreakPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsSubmitting, setSettingsSubmitting] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

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

  const reload = useCallback(async () => {
    if (designPreview) {
      setProfile(DESIGN_PREVIEW_PROFILE);
      setDay(DESIGN_PREVIEW_DAY);
      setPlan(DESIGN_PREVIEW_PLAN);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextProfile, nextDay, nextPlan] = await Promise.all([
        loadEngineerProfile(token),
        loadEngineerDay(token),
        loadEngineerPlan(token),
      ]);
      const missing = missingRequestIds(nextPlan);
      if (missing.length === 0) {
        setPlan(nextPlan);
      } else {
        const extras = await Promise.all(
          missing.map((id) => loadEngineerRequest(token, id).then((body) => body.request)),
        );
        setPlan({ ...nextPlan, requests: [...nextPlan.requests, ...extras] });
      }
      setProfile(nextProfile);
      setDay(nextDay);
    } catch (cause) {
      if (failSession(cause)) return;
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить смену');
    } finally {
      setLoading(false);
    }
  }, [designPreview, failSession, token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const items = useMemo(() => engineerListItems(plan, day), [day, plan]);
  const lunch = useMemo(() => engineerLunchWindow(plan, day), [day, plan]);

  const startJob = async (requestId: string) => {
    if (designPreview) {
      setNotice('В макете факт «приступить» не отправляется.');
      return;
    }
    setStartPendingId(requestId);
    setNotice(null);
    try {
      await sendEngineerLiveAction(token, { kind: 'start', requestId });
      await reload();
    } catch (cause) {
      if (failSession(cause)) return;
      setError(cause instanceof Error ? cause.message : 'Не удалось отметить старт');
    } finally {
      setStartPendingId(null);
    }
  };

  const markLate = (requestId: string) => {
    setLateIds((current) => new Set(current).add(requestId));
    setOnTimeIds((current) => {
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
    setNotice('Отметка «опаздываю» пока только на устройстве — отдельного факта в API ещё нет.');
  };

  const markOnTime = (requestId: string) => {
    setOnTimeIds((current) => new Set(current).add(requestId));
    setLateIds((current) => {
      const next = new Set(current);
      next.delete(requestId);
      return next;
    });
    setNotice('Отметка «буду вовремя» пока только на устройстве.');
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
      await sendEngineerLiveAction(token, { kind: 'break_start' });
      await reload();
      setMenuOpen(false);
    } catch (cause) {
      if (failSession(cause)) return;
      setError(cause instanceof Error ? cause.message : 'Не удалось начать перерыв');
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
  const email = profile?.email ?? fallbackEmail;
  const overlayOpen = openedJob !== null || screen === 'settings';
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
              style={{ fontSize: eu(32) }}
            >
              {engineerHeaderStamp(nowMs)}
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
                    Сегодня заявок нет
                  </p>
                  <p
                    className="font-medium text-figma-muted"
                    style={{ marginTop: eu(8), fontSize: eu(18) }}
                  >
                    Когда диспетчер применит план, список появится здесь.
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
                    latePending={item.kind === 'job' ? lateIds.has(item.request.id) : false}
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
                    onLate={item.kind === 'job' ? () => markLate(item.request.id) : undefined}
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
          {openedJob ? (
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
                  item={openedJob}
                  nowMs={designPreview ? DESIGN_PREVIEW_NOW_MS : nowMs}
                  latePending={lateIds.has(openedJob.request.id)}
                  onTimePending={onTimeIds.has(openedJob.request.id)}
                  onBack={() => {
                    setOpenedJob(null);
                    setNotice(null);
                  }}
                  onRoute={() => openRoute(openedJob)}
                  onLate={() => markLate(openedJob.request.id)}
                  onOnTime={() => markOnTime(openedJob.request.id)}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

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
