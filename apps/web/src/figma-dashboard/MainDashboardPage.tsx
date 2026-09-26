import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { explainWithAi, getMcpSettings, updateDispatcherSettings } from '../api/client';
import type { HandoffView, LiveRouteProgress } from '../api/live';
import type { EngineerView, PlanDelta, PolicyId, RequestView } from '../api/types';
import { DayMap } from '../components/DayMap';
import {
  ALL_REGIONS,
  filterSnapshotByRegion,
  type RegionSelection,
  regionOptions,
  regionStyle,
} from '../domain/regions';
import { clearAssistantSessions } from '../hooks/useAssistantChat';
import { useDashboard } from '../hooks/useDashboard';
import { type CaseExplanation, explainSelection } from '../lib/explanations';
import { formatClock, formatDurationMin } from '../lib/time';
import { AddEntityModal } from './AddEntityModal';
import { AlertsView } from './AlertsView';
import { useArtboardCanvas } from './artboardScale';
import { ArtboardStretchProvider, stretchOf, useArtboardStretch } from './artboardStretch';
import { FIGMA_ASSETS } from './assets';
import { ConfirmDangerModal } from './ConfirmDangerModal';
import { Copyable } from './Copyable';
import type { DangerActionId } from './confirmPhrase';
import { DashboardAi, DashboardChats } from './DashboardAssist';
import { DataUploadModal } from './DataUploadModal';
import { DispatcherAuthPage } from './DispatcherAuthPage';
import { DispatcherDayResults } from './DispatcherDayResults';
import {
  isNavLocked,
  sidebarWheelNav,
  stackSlideDir,
  stackSlideEnter,
  stackSlideExit,
  stackViewKey,
} from './dashboardSlide';
import { EngineersView } from './EngineersView';
import {
  type EngineerCard,
  filterEngineers,
  formatNotificationCount,
  isCompletedStop,
  NAV_ITEMS,
  type NavItemId,
  type NotificationTone,
  type RouteStop,
  requestCountLabel,
  routeStopStatusLabel,
  truncateEnd,
} from './fixtures';
import {
  dashboardViewFromSnapshot,
  nextRouterSettings,
  policyLabel,
  requestUrgency,
  rightPanelMode,
  withLiveRouteStops,
} from './fromSnapshot';
import { McpAgentIndicator } from './McpAgentIndicator';
import { PlanMetricsModal } from './PlanMetricsModal';
import { PolicyComparisonView } from './PolicyComparisonView';
import { FigmaIcon, FigmaText } from './primitives';
import { RegionSwitch } from './RegionSwitch';
import { ReplanDeltaCard } from './ReplanDeltaCard';
import { RequestDetailView } from './RequestDetailView';
import { RequestsView } from './RequestsView';
import { requestEquipmentLabel } from './requestDetail';
import { shortRequestId } from './requestsTable';
import { routeProgressMarker } from './routeProgress';
import { SettingsModal, type SettingsTab } from './SettingsModal';
import { TintIcon } from './TintIcon';
import { ToastColumn } from './ToastColumn';
import {
  dismissToast,
  getToasts,
  pushToast,
  releaseProgressHold,
  seedDemoToasts,
  setToastColumnPinned,
  toastFromAlert,
  upsertNewToasts,
  useToasts,
} from './toasts';
import { WeatherBadge } from './WeatherBadge';
import { WelcomeScreen } from './WelcomeScreen';
import { WorsenModal } from './WorsenModal';
import {
  clearWorkDayStarted,
  hasStartedWorkDay,
  markWorkDayStarted,
  moscowWorkDate,
  shouldShowStartWelcome,
} from './welcomeDay';

const NAV_ICONS = {
  navHome: FIGMA_ASSETS.navHome,
  navRequests: FIGMA_ASSETS.navRequests,
  navEngineers: FIGMA_ASSETS.navEngineers,
  navAlerts: FIGMA_ASSETS.navAlerts,
  navPolicy: FIGMA_ASSETS.navPolicy,
  navChats: FIGMA_ASSETS.navChats,
  navAi: FIGMA_ASSETS.navAi,
} as const;

const NAV_ICON_BOX: Record<NavItemId, { width: number; height: number; className: string }> = {
  day: { width: 22, height: 22, className: 'absolute left-1/2 top-[12px] -translate-x-1/2' },
  requests: { width: 24, height: 18, className: 'absolute left-1/2 top-[14px] -translate-x-1/2' },
  engineers: { width: 24, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
  alerts: { width: 26, height: 26, className: 'absolute left-1/2 top-[8px] -translate-x-1/2' },
  policy: { width: 22, height: 22, className: 'absolute left-1/2 top-[12px] -translate-x-1/2' },
  chats: { width: 26, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
  ai: { width: 24, height: 24, className: 'absolute left-1/2 top-[10px] -translate-x-1/2' },
};

const NAV_ITEM_HEIGHT = 74;
const NAV_ITEM_GAP = 10;
const SEARCH_CONTROL_SIZE = 40;
const SEARCH_OPEN_WIDTH = 351;
const HEADER_LIFT = 16;
const POLICY_LEFT = 1329;
const POLICY_TOP = 26 - HEADER_LIFT;
const ADD_BUTTON_SIZE = 51;
const ADD_BUTTON_GAP = 16;
const METRICS_BUTTON_WIDTH = 232;
const METRICS_BUTTON_LEFT = POLICY_LEFT - ADD_BUTTON_GAP - METRICS_BUTTON_WIDTH;
const ADD_BUTTON_LEFT = METRICS_BUTTON_LEFT - ADD_BUTTON_GAP - ADD_BUTTON_SIZE;
const ADD_BUTTON_TOP = POLICY_TOP;
const POLICY_OPEN_HEIGHT = 585;
const NOTIF_PANEL_LEFT = 1407;
const NOTIF_PANEL_TOP = 26 - HEADER_LIFT;
const HEADER_AVATAR_LEFT = 1800;
const HEADER_AVATAR_TOP = 28 - HEADER_LIFT;
const DATE_TOP = 100 - HEADER_LIFT;
const PANEL_TOP = 154 - HEADER_LIFT;
const PANEL_HEIGHT = 893 + HEADER_LIFT;
const UNASSIGNED_TOP = 778 + HEADER_LIFT;
const CLOSE_PANEL_SIZE = 43;
const MAP_LEFT = 623;
const MAP_COMPACT_WIDTH = 751;
const MAP_EXPANDED_WIDTH = 1267;
const MAP_COMPACT_HEIGHT = 582 + HEADER_LIFT;
const ROUTE_CARD_TOP = 768;
const ROUTE_CARD_HEIGHT = 279;
const DETAIL_PANEL_LEFT = 1406;

/**
 * Where the map sits for a given canvas.
 *
 * Spare width goes to the map and spare height to the panels: the crew column
 * on the left and the detail panel on the right are read top to bottom and gain
 * nothing from being wider, while the map is the one thing on this screen that
 * is always worth more of both.
 */
function mapFrameFor(
  { dx, dy }: { dx: number; dy: number },
  mode: 'expanded' | 'compact' | 'request-only',
) {
  const width = (mode === 'expanded' ? MAP_EXPANDED_WIDTH : MAP_COMPACT_WIDTH) + dx;
  const height = (mode === 'compact' ? MAP_COMPACT_HEIGHT : PANEL_HEIGHT) + dy;
  return { left: MAP_LEFT, top: PANEL_TOP, width, height };
}
const ROUTE_STOP_WIDTH = 260;
const ROUTE_TOPIC_WIDTH = 240;
const ROUTE_DOT_SIZE = 20;
const LAST_PLAN_DELTA_KEY = 'lct.lastPlanDelta';

/** Last rebuild comparison, so «Подробнее» still opens after the live delta was dismissed. */
function readStoredPlanDelta(): PlanDelta | null {
  try {
    const raw = sessionStorage.getItem(LAST_PLAN_DELTA_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PlanDelta>;
    if (!value || !Array.isArray(value.lines) || typeof value.solveMs !== 'number') return null;
    return value as PlanDelta;
  } catch {
    return null;
  }
}

const ROUTE_DOT_LEFT = (ROUTE_TOPIC_WIDTH - ROUTE_DOT_SIZE) / 2;
const ROUTE_LINE_LEFT = 30 + ROUTE_DOT_LEFT + ROUTE_DOT_SIZE / 2;
const PROGRESS_TRACK = 321;

const springQuick = { type: 'spring' as const, stiffness: 420, damping: 36, mass: 0.8 };
const fadeSoft = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };
const slideEase = [0.22, 1, 0.36, 1] as const;
const slide = { duration: 0.34, ease: slideEase };
/**
 * Dispatcher MAIN screen from Figma 28:614 / 29:2552.
 * Stack tabs (including the Requests table) slide vertically; a single request enters from the right.
 */
export function MainDashboardPage() {
  const reduceMotion = useReducedMotion();
  const dash = useDashboard();
  const [policyOpen, setPolicyOpen] = useState(false);
  const [activeNav, setActiveNav] = useState<NavItemId>('day');
  const [stackNav, setStackNav] = useState<NavItemId>('day');
  const [settledPane, setSettledPane] = useState('main');
  const [stackDir, setStackDir] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [reviewDelta, setReviewDelta] = useState<PlanDelta | null>(null);
  const rememberedDelta = useRef<PlanDelta | null>(readStoredPlanDelta());
  useEffect(() => {
    if (!dash.pendingDelta) return;
    rememberedDelta.current = dash.pendingDelta;
    try {
      sessionStorage.setItem(LAST_PLAN_DELTA_KEY, JSON.stringify(dash.pendingDelta));
    } catch {
      /* The panel can still reopen from the in-memory copy. */
    }
  }, [dash.pendingDelta]);
  // The header robot mirrors the server's "an agent is working" marker; the poll is tiny
  // and a failed poll just keeps the last state.
  useEffect(() => {
    const token = dash.token;
    if (!token) {
      setMcpActive(false);
      return;
    }
    let cancelled = false;
    const tick = () => {
      void getMcpSettings(token)
        .then((view) => {
          if (!cancelled) setMcpActive(view.activeNow);
        })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [dash.token]);
  const toasts = useToasts();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [regionOpen, setRegionOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(
    () => !hasStartedWorkDay(window.localStorage, moscowWorkDate()),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [mcpActive, setMcpActive] = useState(false);
  const [dangerAction, setDangerAction] = useState<DangerActionId | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [openedRequestId, setOpenedRequestId] = useState<string | null>(null);
  const [selectedRegion, setSelectedRegion] = useState<RegionSelection>(ALL_REGIONS);

  useEffect(() => {
    const syncWelcome = () => {
      if (!hasStartedWorkDay(window.localStorage, moscowWorkDate())) {
        setWelcomeOpen(true);
      }
    };
    const timer = window.setInterval(syncWelcome, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleSnapshot = useMemo(
    () => (dash.snapshot ? filterSnapshotByRegion(dash.snapshot, selectedRegion) : null),
    [dash.snapshot, selectedRegion],
  );
  const regions = useMemo(
    () => (dash.snapshot ? regionOptions(dash.snapshot) : []),
    [dash.snapshot],
  );

  useEffect(() => {
    if (selectedRegion !== ALL_REGIONS && !regions.some((region) => region.id === selectedRegion)) {
      setSelectedRegion(ALL_REGIONS);
      dash.clearFocus();
    }
  }, [dash.clearFocus, regions, selectedRegion]);
  const view = useMemo(
    () =>
      visibleSnapshot
        ? dashboardViewFromSnapshot(visibleSnapshot, {
            engineerId: dash.selectedEngineerId,
            requestId: dash.selectedRequest?.id ?? null,
          })
        : null,
    [dash.selectedEngineerId, dash.selectedRequest, visibleSnapshot],
  );
  const roster = useMemo(
    () =>
      visibleSnapshot
        ? withLiveRouteStops(view?.engineers ?? [], visibleSnapshot, dash.liveWorkday)
        : [],
    [dash.liveWorkday, view?.engineers, visibleSnapshot],
  );
  const liveProgress = useMemo(
    () =>
      new Map(
        dash.liveWorkday?.engineers.map((engineer) => [engineer.id, engineer.progress]) ?? [],
      ),
    [dash.liveWorkday],
  );
  const visibleEngineers = useMemo(
    () => filterEngineers(roster, searchQuery),
    [roster, searchQuery],
  );
  const liveCompleted = useMemo(
    () =>
      new Map(
        dash.liveWorkday?.engineers.map((engineer) => [
          engineer.id,
          engineer.stats.completedCount + engineer.stats.assumedCompletedCount,
        ]) ?? [],
      ),
    [dash.liveWorkday],
  );
  const engineerNames = useMemo(
    () => new Map((dash.snapshot?.engineers ?? []).map((item) => [item.id, item.displayName])),
    [dash.snapshot],
  );
  const selectedEngineer = dash.selectedEngineerId
    ? (visibleEngineers.find((item) => item.id === dash.selectedEngineerId) ?? null)
    : null;
  const panelMode = rightPanelMode(dash.selectedEngineerId, dash.selectedRequest?.id ?? null);
  const showRightPanel = panelMode !== null;
  const showRouteCard = Boolean(selectedEngineer);
  const mapMode = !showRightPanel ? 'expanded' : showRouteCard ? 'compact' : 'request-only';
  const regionLabel =
    selectedRegion === ALL_REGIONS ? 'Все регионы' : regionStyle(selectedRegion).label;
  const panelExplanation = useMemo(() => {
    if (!dash.snapshot) return null;
    if (panelMode === 'request' && dash.selectedRequest) {
      return explainSelection(
        dash.snapshot,
        dash.selectedRequest,
        dash.selectedAssignment,
        dash.selectedEngineer,
        dash.selectedRoute,
      );
    }
    if (panelMode === 'plan' && dash.selectedEngineer) {
      return explainSelection(dash.snapshot, null, null, dash.selectedEngineer, dash.selectedRoute);
    }
    return null;
  }, [
    dash.selectedAssignment,
    dash.selectedEngineer,
    dash.selectedRequest,
    dash.selectedRoute,
    dash.snapshot,
    panelMode,
  ]);
  useEffect(() => {
    const openAlerts = (dash.snapshot?.alerts ?? []).filter((alert) => alert.resolvedAt === null);
    if (dash.isDemo && openAlerts.length === 0) seedDemoToasts();
  }, [dash.isDemo, dash.snapshot]);

  const toastHydrated = useRef(false);
  const sawRebuild = useRef(false);
  const calculating =
    dash.liveWorkday?.workday.calculating === true ||
    dash.snapshot?.plan.calculating === true ||
    dash.liveWorkday?.workday.routerPhase === 'building' ||
    dash.snapshot?.plan.routerPhase === 'building';
  const routerError =
    dash.liveWorkday?.workday.routerPhase === 'error'
      ? (dash.liveWorkday.workday.routerMessage ?? 'Маршрут не построился')
      : null;
  const geometryDone =
    dash.liveWorkday?.workday.geometryDone ?? dash.snapshot?.plan.geometryDone ?? 0;
  const geometryTotal =
    dash.liveWorkday?.workday.geometryTotal ?? dash.snapshot?.plan.geometryTotal ?? 0;
  const drawingLines = !calculating && geometryTotal > 0 && geometryDone < geometryTotal;
  const showRebuild = dash.rebuilding || calculating;
  useEffect(() => {
    if (!routerError) {
      dismissToast('router-error');
      return;
    }
    pushToast({
      id: 'router-error',
      kind: 'error',
      title: 'Маршрут не построился',
      body: routerError,
    });
  }, [routerError]);
  useEffect(() => {
    if (!drawingLines) {
      releaseProgressHold('router-geometry');
      dismissToast('router-geometry');
      releaseProgressHold('router-geometry');
      return;
    }
    pushToast({
      id: 'router-geometry',
      kind: 'progress',
      title: 'Уточняем линии на карте',
      body: `${geometryDone} из ${geometryTotal}. Пока линия не пришла, на карте прямая.`,
      progress: Math.round((geometryDone / geometryTotal) * 100),
      etaLabel: 'По дорогам',
    });
  }, [drawingLines, geometryDone, geometryTotal]);
  useEffect(() => {
    if (!showRebuild) {
      releaseProgressHold('dispatcher-rebuild');
      dismissToast('dispatcher-rebuild');
      releaseProgressHold('dispatcher-rebuild');
      if (sawRebuild.current) {
        sawRebuild.current = false;
        pushToast({
          id: 'plan-ready',
          kind: 'route',
          title: 'План перестроился',
          body: 'Новый план уже на карте.',
        });
      }
      return;
    }
    sawRebuild.current = true;
    pushToast({
      id: 'dispatcher-rebuild',
      kind: 'progress',
      title: 'Пересчитываем маршруты',
      body: 'План появится на карте, когда расчёт закончится. Это может занять несколько минут.',
      etaLabel: 'Выполняется',
    });
  }, [showRebuild]);
  useEffect(() => {
    const openAlerts = (dash.snapshot?.alerts ?? []).filter((alert) => alert.resolvedAt === null);
    const peek = toastHydrated.current;
    const openIds = new Set(openAlerts.map((alert) => alert.id));
    for (const alert of dash.snapshot?.alerts ?? []) {
      if (alert.resolvedAt !== null || (alert.kind === 'notice' && alert.seenAt !== null))
        dismissToast(`alert:${alert.id}`);
    }
    for (const toast of getToasts()) {
      if (toast.id.startsWith('alert:') && !openIds.has(toast.id.slice('alert:'.length))) {
        dismissToast(toast.id);
      }
    }
    upsertNewToasts(
      openAlerts
        .filter((alert) => alert.kind !== 'notice' || alert.seenAt === null)
        .map(toastFromAlert),
      peek,
    );
    toastHydrated.current = true;
  }, [dash.snapshot]);

  useEffect(() => {
    setToastColumnPinned(notifOpen);
  }, [notifOpen]);

  const hadToasts = useRef(false);
  useEffect(() => {
    if (toasts.length > 0) hadToasts.current = true;
    if (hadToasts.current && toasts.length === 0) setNotifOpen(false);
  }, [toasts.length]);

  const inbox = useMemo(
    () => ({
      count: toasts.length,
      tone: (toasts.some((item) => item.kind === 'alert') ? 'yellow' : 'gray') as NotificationTone,
    }),
    [toasts],
  );
  const policies = (dash.snapshot?.policies ?? []).map((item) => ({
    id: item.policyId,
    label: policyLabel(item.policyId, item.title),
  }));
  const policyId = dash.snapshot?.policyId ?? 'fast';
  const policyTitle = policyLabel(
    policyId,
    dash.snapshot?.policies.find((item) => item.policyId === policyId)?.title,
  );
  const lunchOn = dash.snapshot?.lunchesEnabled ?? false;
  const trafficOn = dash.snapshot?.routerSettings?.trafficEnabled ?? false;
  const metroOn = dash.snapshot?.routerSettings?.metroEnabled ?? false;
  const equipmentTransfersOn = dash.snapshot?.routerSettings?.equipmentTransfersEnabled ?? false;
  const requestCount = view?.requestCount ?? 0;
  const totalKm = view?.totalKm ?? 0;
  const planLabel = view?.planLabel ?? 'Данные рабочего дня загружаются';

  const applyPolicy = (nextPolicy: PolicyId) => {
    if (!dash.snapshot) return;
    dash.applyRoutingSettings(nextPolicy, nextRouterSettings(dash.snapshot, {}));
  };
  const applyLunch = () => {
    if (!dash.snapshot) return;
    dash.applyRoutingSettings(
      dash.snapshot.policyId,
      nextRouterSettings(dash.snapshot, { lunchesEnabled: !dash.snapshot.lunchesEnabled }),
    );
  };
  const applyTraffic = () => {
    if (!dash.snapshot) return;
    dash.applyRoutingSettings(
      dash.snapshot.policyId,
      nextRouterSettings(dash.snapshot, {
        trafficEnabled: !(dash.snapshot.routerSettings?.trafficEnabled ?? false),
      }),
    );
  };
  const applyMetro = () => {
    if (!dash.snapshot) return;
    dash.applyRoutingSettings(
      dash.snapshot.policyId,
      nextRouterSettings(dash.snapshot, {
        metroEnabled: !(dash.snapshot.routerSettings?.metroEnabled ?? false),
      }),
    );
  };
  const applyEquipmentTransfers = () => {
    if (!dash.snapshot) return;
    dash.applyRoutingSettings(
      dash.snapshot.policyId,
      nextRouterSettings(dash.snapshot, {
        equipmentTransfersEnabled: !(
          dash.snapshot.routerSettings?.equipmentTransfersEnabled ?? false
        ),
      }),
    );
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (dangerAction) {
        setDangerAction(null);
        return;
      }
      if (settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      if (metricsOpen) {
        setMetricsOpen(false);
        return;
      }
      if (uploadOpen) {
        if (!dash.uploadingData) setUploadOpen(false);
        return;
      }
      if (addOpen) {
        setAddOpen(false);
        return;
      }
      if (searchOpen) {
        setSearchOpen(false);
        setSearchQuery('');
        return;
      }
      if (notifOpen) {
        setNotifOpen(false);
        return;
      }
      if (userMenuOpen) {
        setUserMenuOpen(false);
        return;
      }
      if (policyOpen) {
        setPolicyOpen(false);
        return;
      }
      if (regionOpen) {
        setRegionOpen(false);
        return;
      }
      if (showRightPanel) dash.clearFocus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    addOpen,
    dangerAction,
    dash,
    metricsOpen,
    notifOpen,
    policyOpen,
    regionOpen,
    searchOpen,
    settingsOpen,
    showRightPanel,
    uploadOpen,
    userMenuOpen,
  ]);

  const canvas = useArtboardCanvas();
  const stretch = stretchOf(canvas);
  const motionOn = !reduceMotion;

  if (!dash.authenticated) {
    return (
      <DispatcherAuthPage
        submitting={dash.loading}
        onSession={dash.acceptLoginSession}
        onPassword={dash.signIn}
      />
    );
  }

  if (dash.source === 'live' && dash.liveLoading && !dash.liveWorkday && !dash.snapshot) {
    return (
      <WelcomeScreen
        requestCount={null}
        motionOn={motionOn}
        disabled={!dash.error}
        buttonLabel={dash.error ? 'Повторить загрузку' : 'Загружаем рабочий день…'}
        onStart={async () => {
          await dash.refreshLive();
        }}
      />
    );
  }

  if (
    shouldShowStartWelcome({
      source: dash.source,
      liveStatus: dash.liveWorkday?.workday.status ?? null,
      welcomeOpen,
      hasSnapshot: dash.snapshot !== null,
    })
  ) {
    return (
      <WelcomeScreen
        requestCount={dash.snapshot ? dash.snapshot.requests.length : null}
        motionOn={motionOn}
        disabled={dash.startingWorkday}
        buttonLabel={dash.startingWorkday ? 'Запускаем рабочий день…' : undefined}
        onStart={async () => {
          if (dash.source === 'live' && !(await dash.startWorkday())) return;
          markWorkDayStarted(window.localStorage, dash.snapshot?.workDate ?? moscowWorkDate());
          setWelcomeOpen(false);
        }}
      />
    );
  }

  if (!dash.snapshot || !visibleSnapshot) {
    return (
      <WelcomeScreen
        requestCount={null}
        motionOn={motionOn}
        disabled={!dash.error}
        buttonLabel={dash.error ? 'Повторить загрузку' : 'Загружаем данные…'}
        onStart={async () => {
          await dash.refresh();
        }}
      />
    );
  }

  return (
    <div className="flex h-full w-full justify-center overflow-auto bg-figma-canvas">
      {/*
       * `zoom`, not `transform: scale`: zoom takes part in layout, so the
       * canvas below really is `canvas.width` wide, children measure themselves
       * in artboard units, and a wider or taller window simply hands the board
       * more of them. A transform would leave the layout at 1920×1080 and only
       * paint it smaller, which is what used to leave black bars either side of
       * an ultrawide monitor.
       */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Outside-pointer dismissal supplements the menus' keyboard-accessible controls; this artboard is not an extra focus target. */}
      <div
        // Clips at its own edge, which is now the window's: screens that let a
        // deck or a veil hang past the drawing (the crew carousel) would
        // otherwise push scrollbars onto the wrapper. The wrapper still scrolls
        // when the board has stopped shrinking and no longer fits.
        className="relative shrink-0 overflow-hidden bg-figma-canvas"
        data-name="MAIN"
        style={{
          width: canvas.width,
          height: canvas.height,
          zoom: canvas.scale,
        }}
        onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (searchOpen && !target.closest('[data-engineer-search]')) {
            setSearchOpen(false);
            setSearchQuery('');
          }
          if (userMenuOpen && !target.closest('[data-user-menu]')) setUserMenuOpen(false);
          if (policyOpen && !target.closest('[data-policy-panel]')) setPolicyOpen(false);
          if (regionOpen && !target.closest('[data-region-panel]')) setRegionOpen(false);
        }}
      >
        <ArtboardStretchProvider value={stretch}>
          <SidebarNav
            activeNav={activeNav}
            motionOn={motionOn}
            onSelect={(id) => {
              if (isNavLocked(id)) return;
              if (id === 'requests' && activeNav === 'requests') {
                setOpenedRequestId(null);
              }
              if (id !== 'requests') {
                setOpenedRequestId(null);
              }
              setStackDir(stackSlideDir(stackNav, id));
              setStackNav(id);
              setActiveNav(id);
              setPolicyOpen(false);
              if (id === 'alerts') setUserMenuOpen(false);
            }}
            onUpload={() => {
              setPolicyOpen(false);
              setUserMenuOpen(false);
              setUploadOpen(true);
            }}
          />
          <AddEntityButton
            motionOn={motionOn}
            onOpen={() => {
              setPolicyOpen(false);
              setUserMenuOpen(false);
              setNotifOpen(false);
              setUploadOpen(false);
              setMetricsOpen(false);
              setAddOpen(true);
            }}
          />
          <PlanMetricsButton
            motionOn={motionOn}
            onOpen={() => {
              setPolicyOpen(false);
              setUserMenuOpen(false);
              setNotifOpen(false);
              setUploadOpen(false);
              setAddOpen(false);
              setMetricsOpen(true);
            }}
          />
          <PlanMetricsModal
            open={metricsOpen}
            motionOn={motionOn}
            snapshot={dash.snapshot}
            comparison={dash.policyComparison}
            token={dash.token}
            onOpenRequest={(requestId) => {
              setMetricsOpen(false);
              setStackDir(stackSlideDir(stackNav, 'requests'));
              setStackNav('requests');
              setActiveNav('requests');
              setOpenedRequestId(requestId);
              dash.selectRequest(requestId);
            }}
            onClose={() => setMetricsOpen(false)}
          />
          <AddEntityModal
            open={addOpen}
            snapshot={dash.snapshot}
            motionOn={motionOn}
            live={dash.source === 'live'}
            token={dash.token}
            submitting={dash.entityMutationPending}
            onClose={() => setAddOpen(false)}
            onCreateRequest={dash.createRequest}
            onCreateEngineer={dash.createEngineer}
          />
          <PolicyControl
            open={policyOpen}
            policyLabel={policyTitle}
            policies={policies}
            selectedId={policyId}
            lunchOn={lunchOn}
            trafficOn={trafficOn}
            metroOn={metroOn}
            equipmentTransfersOn={equipmentTransfersOn}
            motionOn={motionOn}
            onToggle={() => {
              setUserMenuOpen(false);
              setAddOpen(false);
              setPolicyOpen((value) => !value);
            }}
            onSelect={applyPolicy}
            onLunchToggle={applyLunch}
            onTrafficToggle={applyTraffic}
            onMetroToggle={applyMetro}
            onEquipmentTransfersToggle={applyEquipmentTransfers}
            onManualMode={() => {
              if (!dash.snapshot) return;
              void dash.setMode(dash.snapshot.plan.mode === 'auto' ? 'manual' : 'auto');
            }}
          />
          <NotificationControl
            open={notifOpen}
            count={inbox.count}
            tone={inbox.tone}
            motionOn={motionOn}
            onToggle={() => {
              setPolicyOpen(false);
              setUserMenuOpen(false);
              setNotifOpen((value) => !value);
            }}
          />
          <ToastColumn
            open={notifOpen}
            motionOn={motionOn}
            scale={canvas.scale}
            onCollapse={() => {
              setNotifOpen(false);
              setToastColumnPinned(false);
            }}
            onToastAction={(toast) => {
              if (!toast.actionLabel) return;
              const next = dash.pendingDelta ?? rememberedDelta.current;
              if (next) setReviewDelta(next);
            }}
          />
          <AnimatePresence>
            {reviewDelta ? (
              <ReplanDeltaCard
                key="replan-delta"
                delta={reviewDelta}
                canReject={dash.canRejectDelta && reviewDelta === dash.pendingDelta}
                busy={dash.rebuilding}
                motionOn={motionOn}
                onAccept={() => {
                  setReviewDelta(null);
                  if (dash.pendingDelta) dash.acceptDelta();
                }}
                onReject={() => {
                  setReviewDelta(null);
                  dash.rejectDelta();
                }}
                onOpenRequest={(requestId) => {
                  setReviewDelta(null);
                  setStackDir(stackSlideDir(stackNav, 'day'));
                  setStackNav('day');
                  setActiveNav('day');
                  dash.selectRequest(requestId);
                }}
              />
            ) : null}
          </AnimatePresence>
          <DataUploadModal
            open={uploadOpen}
            submitting={dash.uploadingData}
            readOnly={dash.writesDisabled}
            existingRegions={regions.map((region) => region.id)}
            motionOn={motionOn}
            onClose={() => {
              if (!dash.uploadingData) setUploadOpen(false);
            }}
            onUpload={dash.uploadDataset}
            onImportOfficial={dash.importOfficialTzDataset}
            onRoadImport={dash.importRoadResource}
          />
          <UserMenu
            open={userMenuOpen}
            covered={notifOpen}
            motionOn={motionOn}
            onToggle={() => {
              setPolicyOpen(false);
              setUserMenuOpen((value) => !value);
            }}
            onSettings={() => {
              setUserMenuOpen(false);
              setSettingsTab('general');
              setSettingsOpen(true);
            }}
            onEndDay={() => {
              setUserMenuOpen(false);
              setResultsOpen(true);
            }}
            demoStand={dash.liveWorkday?.demoStand === true}
            onRestartDay={() => {
              setUserMenuOpen(false);
              setDangerAction('restartDay');
            }}
            onReset={() => {
              setUserMenuOpen(false);
              setDangerAction('resetData');
            }}
            onSignOut={() => {
              setUserMenuOpen(false);
              setDangerAction('signOut');
            }}
          />
          <SettingsModal
            open={settingsOpen}
            motionOn={motionOn}
            token={dash.token}
            routerSettings={dash.snapshot?.routerSettings}
            submitting={dash.busy}
            initialTab={settingsTab}
            onClose={() => setSettingsOpen(false)}
            onSave={async ({ dispatcher, router }) => {
              if (!dash.token || !dash.snapshot) {
                throw new Error('Нужна живая сессия диспетчера');
              }
              await updateDispatcherSettings(dash.token, dispatcher);
              dash.applyRoutingSettings(dash.snapshot.policyId, router);
              setSettingsOpen(false);
            }}
          />
          {dash.token ? (
            <DispatcherDayResults
              token={dash.token}
              live={dash.liveWorkday}
              shift={dash.snapshot?.shift}
              open={resultsOpen}
              onOpen={() => setResultsOpen(true)}
              onClose={() => setResultsOpen(false)}
              closeShift={dash.closeShift}
              requests={dash.snapshot?.requests ?? []}
              workDate={dash.snapshot?.workDate ?? dash.liveWorkday?.workday.workDate ?? null}
            />
          ) : null}
          <WorsenModal
            text={dash.worseningText}
            onCancel={() => dash.answerWorsening(false)}
            onConfirm={() => dash.answerWorsening(true)}
          />
          <ConfirmDangerModal
            actionId={dangerAction}
            motionOn={motionOn}
            onCancel={() => setDangerAction(null)}
            onConfirm={(id) => {
              setDangerAction(null);
              if (id === 'endDay') {
                if (dash.snapshot) {
                  void dash
                    .closeShift(dash.snapshot.workDate, crypto.randomUUID())
                    .then(() => {
                      pushToast({
                        id: 'shift-closed',
                        kind: 'system',
                        title: 'Смена закрыта',
                        body: 'Сервер подтвердил закрытие диспетчерской смены.',
                      });
                    })
                    .catch((cause: unknown) => {
                      pushToast({
                        id: 'shift-close-error',
                        kind: 'error',
                        title: 'Не удалось закрыть смену',
                        body: cause instanceof Error ? cause.message : 'Повторите действие позже.',
                      });
                    });
                }
                return;
              }
              if (id === 'restartDay' || id === 'resetData') {
                if (!dash.liveWorkday?.demoStand) {
                  pushToast({
                    id: `unsupported-${id}`,
                    kind: 'system',
                    title: 'Действие пока недоступно',
                    body: 'Перезапуск дня доступен на публичном демо-стенде.',
                  });
                  return;
                }
                void dash
                  .restartDemoDay()
                  .then(() => {
                    clearWorkDayStarted(window.localStorage);
                    clearAssistantSessions(window.localStorage);
                    setWelcomeOpen(true);
                    pushToast({
                      id: 'demo-day-restarted',
                      kind: 'system',
                      title: 'День сброшен',
                      body: 'Исходный набор из 14 заявок и двух инженеров готов. Почта бригады снята.',
                    });
                  })
                  .catch((cause: unknown) => {
                    pushToast({
                      id: 'demo-day-restart-error',
                      kind: 'error',
                      title: 'Не удалось начать день заново',
                      body: cause instanceof Error ? cause.message : 'Повторите действие позже.',
                    });
                  });
                return;
              }
              void dash.signOut();
            }}
          />
          {activeNav === 'requests' && openedRequestId ? null : (
            <div
              className="absolute left-[180px] z-[15] flex h-[40px] items-center gap-[14px]"
              style={{ top: DATE_TOP }}
            >
              <FigmaText className="figma-nowrap font-murs text-[32px] tracking-[-0.544px] text-figma-ink">
                {view?.dateLabel ?? 'Рабочий день'}
                {dash.liveWorkday ? ` · ${formatClock(dash.liveWorkday.workday.liveNow)}` : ''}
              </FigmaText>
              <McpAgentIndicator
                active={mcpActive}
                motionOn={motionOn}
                onClick={() => {
                  setSettingsTab('api');
                  setSettingsOpen(true);
                }}
              />
            </div>
          )}
          <div
            className={`absolute inset-0 ${
              stackViewKey(stackNav) === 'engineers' ? 'overflow-visible' : 'overflow-hidden'
            }`}
          >
            <AnimatePresence initial={false} custom={stackDir}>
              <motion.div
                key={stackViewKey(stackNav)}
                custom={stackDir}
                className={`absolute inset-0 isolate bg-figma-canvas ${
                  settledPane === stackViewKey(stackNav) ? 'stack-pane-settled' : ''
                }`}
                initial={motionOn && stackDir !== 0 ? stackSlideEnter(stackDir) : false}
                animate={{ x: 0, y: 0 }}
                exit={motionOn && stackDir !== 0 ? stackSlideExit(stackDir) : undefined}
                transition={motionOn && stackDir !== 0 ? slide : { duration: 0 }}
                onAnimationStart={() => setSettledPane('')}
                onAnimationComplete={() => setSettledPane(stackViewKey(stackNav))}
              >
                {stackViewKey(stackNav) === 'chats' ? <DashboardChats token={dash.token} /> : null}
                {stackViewKey(stackNav) === 'ai' ? (
                  <DashboardAi
                    token={dash.token}
                    onOpenObject={(target) => {
                      if (target.type === 'request') {
                        setStackDir(stackSlideDir(stackNav, 'requests'));
                        setStackNav('requests');
                        setActiveNav('requests');
                        setOpenedRequestId(target.id);
                        dash.selectRequest(target.id);
                        return;
                      }
                      if (target.type === 'engineer') {
                        setStackDir(stackSlideDir(stackNav, 'engineers'));
                        setStackNav('engineers');
                        setActiveNav('engineers');
                        dash.selectEngineer(target.id);
                        return;
                      }
                      setStackDir(stackSlideDir(stackNav, 'alerts'));
                      setStackNav('alerts');
                      setActiveNav('alerts');
                    }}
                  />
                ) : null}
                {stackViewKey(stackNav) === 'policy' ? (
                  <PolicyComparisonView
                    snapshot={dash.snapshot}
                    comparison={dash.policyComparison}
                    loading={dash.policyComparisonLoading}
                    error={dash.policyComparisonError}
                    recorded={dash.isDemo}
                    readOnly={dash.source === 'cached'}
                    token={dash.token}
                    onRefresh={() => void dash.refreshPolicyComparison()}
                    regions={[
                      { id: ALL_REGIONS, label: 'Все регионы' },
                      ...regions.map((item) => ({ id: item.id, label: item.label })),
                    ]}
                    selectedRegion={selectedRegion}
                    motionOn={motionOn}
                  />
                ) : null}
                {stackViewKey(stackNav) === 'alerts' ? (
                  <AlertsView
                    token={dash.token ?? undefined}
                    snapshot={dash.snapshot}
                    toasts={toasts}
                    demoMode={dash.isDemo}
                    motionOn={motionOn}
                    onMarkNoticeSeen={dash.markNoticeSeen}
                    onResolve={dash.resolveAlert}
                    writesDisabled={dash.writesDisabled || dash.busy}
                    onOpenRequest={(requestId) => {
                      setStackDir(stackSlideDir(stackNav, 'requests'));
                      setStackNav('requests');
                      setActiveNav('requests');
                      setOpenedRequestId(requestId);
                      dash.selectRequest(requestId);
                    }}
                  />
                ) : null}
                {stackViewKey(stackNav) === 'requests' ? (
                  <RequestsView
                    snapshot={dash.snapshot}
                    selectedRequestId={dash.selectedRequest?.id ?? null}
                    onSelect={(requestId) => {
                      setOpenedRequestId(requestId);
                      dash.selectRequest(requestId);
                    }}
                  />
                ) : null}
                {stackViewKey(stackNav) === 'engineers' ? (
                  <EngineersView
                    token={dash.source === 'live' ? (dash.token ?? undefined) : undefined}
                    snapshot={visibleSnapshot}
                    handoffs={dash.liveWorkday?.handoffs ?? []}
                    selectedEngineerId={dash.selectedEngineerId}
                    motionOn={motionOn}
                    busy={dash.busy || dash.writesDisabled}
                    onSelectEngineer={dash.selectEngineer}
                    onLinkEmail={dash.saveEngineerLogin}
                    onDeleteEngineer={dash.deleteEngineer}
                    onSetAvailability={(engineerId, availability) => {
                      void dash.updateEngineerAvailability(engineerId, availability);
                    }}
                  />
                ) : null}
                {stackViewKey(stackNav) === 'main' ? (
                  <>
                    <EngineersColumn
                      engineers={visibleEngineers}
                      totalCount={roster.length}
                      requestCount={requestCount}
                      totalKm={totalKm}
                      planLabel={planLabel}
                      unassignedTitle={view?.unassignedTitle ?? 'Данные загружаются'}
                      unassignedReason={view?.unassignedReason ?? '—'}
                      selectedEngineerId={dash.selectedEngineerId}
                      searchOpen={searchOpen}
                      searchQuery={searchQuery}
                      motionOn={motionOn}
                      onSearchToggle={() => {
                        if (searchOpen) {
                          setSearchOpen(false);
                          setSearchQuery('');
                          return;
                        }
                        setSearchOpen(true);
                      }}
                      onSearchChange={setSearchQuery}
                      onSelect={(id) => {
                        dash.selectEngineer(id);
                        setSearchOpen(false);
                        setSearchQuery('');
                      }}
                      onSelectUnassigned={() => {
                        if (view?.firstUnassignedId) dash.selectRequest(view.firstUnassignedId);
                      }}
                    />
                    <MapCard
                      snapshot={visibleSnapshot}
                      selectedEngineerId={dash.selectedEngineerId}
                      selectedRequestId={dash.selectedRequest?.id ?? null}
                      progressByEngineer={liveProgress}
                      completedByEngineer={liveCompleted}
                      handoffs={dash.liveWorkday?.handoffs ?? []}
                      frame={mapFrameFor(stretch, mapMode)}
                      regionLabel={regionLabel}
                      regions={[
                        { id: ALL_REGIONS, label: 'Все регионы' },
                        ...regions.map((item) => ({ id: item.id, label: item.label })),
                      ]}
                      selectedRegion={selectedRegion}
                      regionOpen={regionOpen}
                      motionOn={motionOn}
                      onSelectRequest={dash.selectRequest}
                      onToggleRegion={() => {
                        setPolicyOpen(false);
                        setUserMenuOpen(false);
                        setRegionOpen((value) => !value);
                      }}
                      onSelectRegion={(id) => {
                        setSelectedRegion(id);
                        setRegionOpen(false);
                        dash.clearFocus();
                      }}
                      token={dash.token}
                    />
                    <AnimatePresence>
                      {showRouteCard && selectedEngineer ? (
                        <RouteCard
                          key="route-card"
                          engineer={selectedEngineer}
                          progress={liveProgress.get(selectedEngineer.id) ?? null}
                          handoffs={dash.liveWorkday?.handoffs ?? []}
                          engineerNames={engineerNames}
                          motionOn={motionOn}
                          onSelectRequest={dash.selectRequest}
                        />
                      ) : null}
                    </AnimatePresence>
                    <AnimatePresence>
                      {showRightPanel ? (
                        <DetailPanel
                          key={
                            panelMode === 'request'
                              ? (dash.selectedRequest?.id ?? 'request')
                              : (dash.selectedEngineerId ?? 'plan')
                          }
                          mode={panelMode === 'request' ? 'request' : 'plan'}
                          onOpenEngineer={() => {
                            setStackDir(stackSlideDir(stackNav, 'engineers'));
                            setStackNav('engineers');
                            setActiveNav('engineers');
                          }}
                          request={dash.selectedRequest}
                          engineer={dash.selectedEngineer}
                          explanation={panelExplanation}
                          token={dash.token}
                          roster={(dash.snapshot?.engineers ?? []).slice(0, 8).map((item) => ({
                            name: item.displayName,
                            skills: item.skills,
                            transport: item.transportType,
                            availability: item.day?.availability ?? null,
                          }))}
                          motionOn={motionOn}
                          onClose={() => dash.clearFocus()}
                        />
                      ) : null}
                    </AnimatePresence>
                  </>
                ) : null}
              </motion.div>
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {activeNav === 'requests' && openedRequestId ? (
                <motion.div
                  key={openedRequestId}
                  className="absolute inset-0 isolate z-10 bg-figma-canvas"
                  initial={motionOn ? { x: '100%' } : false}
                  animate={{ x: 0 }}
                  exit={motionOn ? { x: '100%' } : undefined}
                  transition={motionOn ? slide : { duration: 0 }}
                >
                  <RequestDetailView
                    token={dash.source === 'live' ? (dash.token ?? undefined) : undefined}
                    snapshot={dash.snapshot}
                    requestId={openedRequestId}
                    motionOn={motionOn}
                    onBack={() => {
                      setOpenedRequestId(null);
                      dash.clearFocus();
                    }}
                    onCancelVisit={
                      dash.writesDisabled
                        ? undefined
                        : async () => {
                            await dash.cancelRequest(openedRequestId);
                            setOpenedRequestId(null);
                            dash.clearFocus();
                          }
                    }
                    onAssignEngineer={
                      dash.writesDisabled
                        ? undefined
                        : async (engineerId) => {
                            await dash.assignRequest(openedRequestId, engineerId);
                          }
                    }
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </ArtboardStretchProvider>
      </div>
    </div>
  );
}

function SidebarNav({
  activeNav,
  onSelect,
  onUpload,
  motionOn,
}: {
  activeNav: NavItemId;
  onSelect: (id: NavItemId) => void;
  onUpload: () => void;
  motionOn: boolean;
}) {
  const activeIndex = NAV_ITEMS.findIndex((item) => item.id === activeNav);
  const railRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const next = sidebarWheelNav(activeNav, event.deltaY);
      if (next) onSelect(next);
    };
    rail.addEventListener('wheel', onWheel, { passive: false });
    return () => rail.removeEventListener('wheel', onWheel);
  }, [activeNav, onSelect]);

  return (
    <aside
      ref={railRef}
      className="absolute inset-y-0 left-0 z-20 w-[158px] overflow-visible rounded-br-[20px] rounded-tr-[20px] border-r-[0.5px] border-solid border-[rgba(158,158,158,0.3)] bg-white"
    >
      <div className="absolute left-[79px] top-[56px] -translate-x-1/2 -translate-y-1/2">
        <FigmaIcon src={FIGMA_ASSETS.logo} alt="LCT Smart Router" width={64} height={64} />
      </div>
      <nav className="absolute left-[12px] top-[110px] w-[134px]">
        <motion.div
          aria-hidden
          className="absolute left-0 top-0 h-[74px] w-full rounded-[10px] bg-figma-ink"
          initial={false}
          animate={{ y: activeIndex * (NAV_ITEM_HEIGHT + NAV_ITEM_GAP) }}
          transition={motionOn ? springQuick : { duration: 0 }}
        />
        {NAV_ITEMS.map((item) => {
          const active = item.id === activeNav;
          const locked = isNavLocked(item.id);
          const icon = NAV_ICON_BOX[item.id];
          return (
            <button
              key={item.id}
              type="button"
              disabled={locked}
              aria-label={item.label}
              aria-disabled={locked}
              title={locked ? 'Скоро' : undefined}
              onClick={() => onSelect(item.id)}
              className={`relative flex h-[74px] w-full items-end justify-center pb-[12px] transition-transform duration-200 ease-out ${
                locked ? 'cursor-not-allowed opacity-35' : 'hover:scale-[1.02]'
              }`}
              style={{ marginBottom: NAV_ITEM_GAP }}
            >
              <FigmaIcon
                src={NAV_ICONS[item.icon]}
                alt=""
                width={icon.width}
                height={icon.height}
                className={`${icon.className} ${active ? 'nav-glyph-on' : 'nav-glyph-off'} transition-[filter] duration-150`}
              />
              <FigmaText
                className={`figma-nowrap relative z-10 font-semibold text-[16px] tracking-[-0.272px] transition-colors duration-150 ${
                  active ? 'text-white' : 'text-figma-muted'
                }`}
              >
                {item.label}
              </FigmaText>
            </button>
          );
        })}
      </nav>
      <motion.button
        type="button"
        aria-label="Загрузить данные"
        onClick={onUpload}
        className="absolute bottom-[28px] left-[12px] flex h-[56px] w-[134px] items-center justify-center rounded-full"
        whileHover={motionOn ? { scale: 1.12 } : undefined}
        whileTap={motionOn ? { scale: 0.94 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <FigmaIcon src={FIGMA_ASSETS.iconUpload} alt="" width={28} height={28} />
      </motion.button>
    </aside>
  );
}

/**
 * Header bell toggles the right-hand toast column. While the column is open the
 * bell stays in the header under the veil (z below the column); the column's own
 * collapse bubble closes it.
 */
function NotificationControl({
  open,
  count,
  tone,
  motionOn,
  onToggle,
}: {
  open: boolean;
  count: number;
  tone: NotificationTone;
  motionOn: boolean;
  onToggle: () => void;
}) {
  const { dx } = useArtboardStretch();
  return (
    <div
      data-notif-panel
      className="pointer-events-none absolute z-[70]"
      style={{ left: NOTIF_PANEL_LEFT + dx, top: NOTIF_PANEL_TOP, width: 363, height: 51 }}
    >
      <motion.button
        type="button"
        aria-label={open ? 'Скрыть уведомления' : 'Показать уведомления'}
        aria-pressed={open}
        onClick={onToggle}
        className="pointer-events-auto absolute right-[6px] top-[6px] flex size-[43px] items-center justify-center"
        whileHover={motionOn ? { scale: 1.08 } : undefined}
        whileTap={motionOn ? { scale: 0.96 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <span className="relative">
          <FigmaIcon src={FIGMA_ASSETS.bellHeader} alt="" width={30} height={30} />
          {count > 0 ? <NotificationBadge count={count} tone={tone} /> : null}
        </span>
      </motion.button>
    </div>
  );
}

/**
 * Avatar + chevron open a compact account menu.
 */
function UserMenu({
  open,
  covered,
  motionOn,
  demoStand,
  onToggle,
  onSettings,
  onEndDay,
  onRestartDay,
  onReset,
  onSignOut,
}: {
  open: boolean;
  covered: boolean;
  motionOn: boolean;
  demoStand: boolean;
  onToggle: () => void;
  onSettings: () => void;
  onEndDay: () => void;
  onRestartDay: () => void;
  onReset: () => void;
  onSignOut: () => void;
}) {
  const { dx } = useArtboardStretch();
  return (
    <div
      data-user-menu
      className={`absolute ${covered ? 'z-[40]' : 'z-[85]'}`}
      style={{ left: HEADER_AVATAR_LEFT + dx, top: HEADER_AVATAR_TOP }}
    >
      <motion.button
        type="button"
        onClick={onToggle}
        className="relative z-50 flex items-center gap-[20px]"
        aria-label="Меню пользователя"
        whileHover={motionOn ? { scale: 1.04 } : undefined}
        whileTap={motionOn ? { scale: 0.98 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <div className="relative size-[50px] overflow-clip rounded-[81px] bg-figma-ink">
          <img
            alt=""
            src={FIGMA_ASSETS.avatarUser}
            className="absolute left-0 top-[-2px] size-[52px] max-w-none object-cover"
          />
        </div>
        <motion.span
          className="flex size-[20px] items-center justify-center"
          animate={{ rotate: open ? 180 : 0 }}
          whileHover={motionOn && !open ? { rotate: 18 } : undefined}
          transition={{ duration: 0.2 }}
        >
          <FigmaIcon src={FIGMA_ASSETS.chevronDown} alt="" width={20} height={20} />
        </motion.span>
      </motion.button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="absolute right-0 top-[62px] z-[90] flex w-[230px] flex-col rounded-[16px] bg-white p-[10px]"
            initial={motionOn ? { opacity: 0, y: -8, scale: 0.96 } : false}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={motionOn ? { opacity: 0, y: -8, scale: 0.96 } : undefined}
            transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
            style={{ boxShadow: '0 16px 36px rgba(39, 41, 48, 0.16)' }}
          >
            <div className="flex flex-col gap-[8px]">
              <MenuAction motionOn={motionOn} tone="ink" onClick={onSettings}>
                Настройки
              </MenuAction>
            </div>
            <div className="mx-auto my-[8px] h-px w-[40px] bg-figma-ink/20" />
            <div className="flex flex-col gap-[8px]">
              <MenuAction motionOn={motionOn} tone="bee" onClick={onEndDay}>
                Завершить день
              </MenuAction>
              {demoStand ? (
                <MenuAction motionOn={motionOn} tone="danger" onClick={onRestartDay}>
                  День заново
                </MenuAction>
              ) : null}
            </div>
            <div className="mx-auto my-[8px] h-px w-[40px] bg-figma-ink/20" />
            <div className="flex flex-col gap-[8px]">
              {demoStand ? (
                <MenuAction motionOn={motionOn} tone="danger" onClick={onReset}>
                  Сбросить данные
                </MenuAction>
              ) : null}
              <MenuAction motionOn={motionOn} tone="danger" onClick={onSignOut}>
                Выйти
              </MenuAction>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function MenuAction({
  tone,
  motionOn,
  onClick,
  children,
}: {
  tone: 'ink' | 'bee' | 'danger';
  motionOn: boolean;
  onClick: () => void;
  children: string;
}) {
  const palette =
    tone === 'bee'
      ? 'bg-figma-bee text-figma-ink'
      : tone === 'ink'
        ? 'bg-figma-ink text-white'
        : 'bg-figma-danger text-white';
  return (
    <motion.button
      type="button"
      aria-label={children}
      onClick={onClick}
      className={`flex h-[44px] w-full items-center justify-center rounded-[12px] font-semibold text-[16px] ${palette}`}
      whileHover={motionOn ? { scale: 1.03, filter: 'brightness(1.08)' } : undefined}
      whileTap={motionOn ? { scale: 0.98 } : undefined}
      transition={{ duration: 0.16 }}
    >
      {children}
    </motion.button>
  );
}

/**
 * Notification bubble: circle for 1 digit, pill for 2 digits and 99+.
 */
function NotificationBadge({ count, tone }: { count: number; tone: NotificationTone }) {
  const label = formatNotificationCount(count);
  const wide = label.length > 1;
  return (
    <span
      className={`absolute -right-[6px] -top-[4px] flex h-[20px] items-center justify-center rounded-full font-medium text-[12px] leading-none whitespace-nowrap tabular-nums ${
        wide ? 'min-w-[28px] px-[7px]' : 'w-[20px]'
      } ${tone === 'yellow' ? 'bg-figma-bee text-figma-ink' : 'bg-figma-muted text-white'}`}
    >
      {label}
    </span>
  );
}

/**
 * Dark plus in the MAIN header, left of the policy chip. Opens the add-entity dialog.
 */
function PlanMetricsButton({ motionOn, onOpen }: { motionOn: boolean; onOpen: () => void }) {
  const { dx } = useArtboardStretch();
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      className="absolute z-50 flex h-[51px] items-center gap-[10px] rounded-[27px] bg-figma-ink py-[4px] pl-[4px] pr-[16px] text-white"
      style={{ left: METRICS_BUTTON_LEFT + dx, top: POLICY_TOP, width: METRICS_BUTTON_WIDTH }}
      whileHover={motionOn ? { y: -1 } : undefined}
      whileTap={motionOn ? { scale: 0.98 } : undefined}
      transition={{ duration: 0.16 }}
    >
      <span className="flex size-[43px] shrink-0 items-center justify-center rounded-full bg-white">
        <TintIcon src="/figma/chart-dots-2.svg" color="#272930" size={22} />
      </span>
      <span className="figma-nowrap font-semibold text-[18px] tracking-[-0.3px]">
        Метрики плана
      </span>
    </motion.button>
  );
}

function AddEntityButton({ motionOn, onOpen }: { motionOn: boolean; onOpen: () => void }) {
  const { dx } = useArtboardStretch();
  return (
    <motion.button
      type="button"
      aria-label="Добавить"
      onClick={onOpen}
      className="absolute z-50 flex items-center justify-center rounded-full bg-figma-ink"
      style={{
        left: ADD_BUTTON_LEFT + dx,
        top: ADD_BUTTON_TOP,
        width: ADD_BUTTON_SIZE,
        height: ADD_BUTTON_SIZE,
      }}
      whileHover={motionOn ? { scale: 1.08 } : undefined}
      whileTap={motionOn ? { scale: 0.96 } : undefined}
      transition={{ duration: 0.16 }}
    >
      <FigmaIcon src={FIGMA_ASSETS.iconPlusWhite} alt="" width={22} height={22} />
    </motion.button>
  );
}

function PolicyControl({
  open,
  policyLabel: selectedLabel,
  policies,
  selectedId,
  lunchOn,
  trafficOn,
  metroOn,
  equipmentTransfersOn,
  motionOn,
  onToggle,
  onSelect,
  onLunchToggle,
  onTrafficToggle,
  onMetroToggle,
  onEquipmentTransfersToggle,
  onManualMode,
}: {
  open: boolean;
  policyLabel: string;
  policies: { id: PolicyId; label: string }[];
  selectedId: PolicyId;
  lunchOn: boolean;
  trafficOn: boolean;
  metroOn: boolean;
  equipmentTransfersOn: boolean;
  motionOn: boolean;
  onToggle: () => void;
  onSelect: (policy: PolicyId) => void;
  onLunchToggle: () => void;
  onTrafficToggle: () => void;
  onMetroToggle: () => void;
  onEquipmentTransfersToggle: () => void;
  onManualMode: () => void;
}) {
  const { dx } = useArtboardStretch();
  const options =
    policies.length > 0
      ? policies
      : (['fast', 'compact', 'sla', 'balanced', 'eco', 'covering'] as const).map((id) => ({
          id,
          label: policyLabel(id),
        }));
  const extra = Math.max(0, options.length - 6) * 44;
  return (
    <motion.div
      data-policy-panel
      className="absolute z-50 w-[363px] overflow-hidden rounded-[27px] bg-white"
      style={{ left: POLICY_LEFT + dx, top: POLICY_TOP }}
      initial={false}
      animate={{
        height: open ? POLICY_OPEN_HEIGHT + extra : 51,
        boxShadow: open ? '0 22px 48px rgba(39, 41, 48, 0.18)' : '0 0 0 rgba(39, 41, 48, 0)',
      }}
      transition={
        motionOn
          ? {
              height: { duration: 0.44, ease: [0.22, 1, 0.36, 1] },
              boxShadow: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
            }
          : { duration: 0 }
      }
    >
      <div className="relative h-[51px] w-full">
        <motion.button
          type="button"
          onClick={onToggle}
          className="absolute inset-y-0 left-0 right-[52px] px-[16px] text-left"
          whileHover={motionOn ? { x: 2 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <FigmaText className="figma-nowrap font-semibold text-[18px] tracking-[-0.306px] text-figma-ink">
            {open ? 'Выбери свою политику' : `Политика: ${selectedLabel}`}
          </FigmaText>
        </motion.button>
        <motion.button
          type="button"
          onClick={onToggle}
          className="absolute right-[4px] top-[4px] size-[43px]"
          whileHover={motionOn ? { scale: 1.08 } : undefined}
          whileTap={motionOn ? { scale: 0.96 } : undefined}
          transition={{ duration: 0.16 }}
        >
          <motion.span
            className="flex size-[43px] origin-center items-center justify-center will-change-transform"
            initial={false}
            animate={{ rotate: open ? 180 : 0 }}
            transition={motionOn ? { duration: 0.44, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
          >
            <FigmaIcon
              src={FIGMA_ASSETS.policyArrowClosed}
              alt={open ? 'Свернуть' : 'Открыть политики'}
              width={43}
              height={43}
            />
          </motion.span>
        </motion.button>
      </div>
      <div
        className={`relative w-[363px] ${open ? '' : 'pointer-events-none'}`}
        style={{ height: 548 + extra }}
      >
        {options.map((option, index) => (
          <motion.button
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id)}
            className="absolute left-0 h-[32px] w-full"
            style={{ top: 14 + index * 44 }}
            whileHover={motionOn ? { x: 4 } : undefined}
            transition={{ duration: 0.16 }}
          >
            <FigmaIcon
              src={option.id === selectedId ? FIGMA_ASSETS.radioFilled : FIGMA_ASSETS.radioEmpty}
              alt=""
              width={24}
              height={24}
              className="absolute left-[16px] top-0"
            />
            <FigmaText className="figma-nowrap absolute left-[50px] top-[4px] font-medium text-[20px] text-figma-ink">
              {option.label}
            </FigmaText>
          </motion.button>
        ))}
        <PolicySwitch
          on={lunchOn}
          label="Рассчитать обеды"
          top={274 + extra}
          motionOn={motionOn}
          onToggle={onLunchToggle}
        />
        <PolicySwitch
          on={trafficOn}
          label="Прогнозировать пробки"
          top={318 + extra}
          motionOn={motionOn}
          onToggle={onTrafficToggle}
        />
        <PolicySwitch
          on={metroOn}
          label="Маршруты с метро"
          top={362 + extra}
          motionOn={motionOn}
          onToggle={onMetroToggle}
        />
        <PolicySwitch
          on={equipmentTransfersOn}
          label="Передача оборудования"
          top={406 + extra}
          motionOn={motionOn}
          onToggle={onEquipmentTransfersToggle}
        />
        <button
          type="button"
          onClick={onManualMode}
          className="absolute left-[16px] flex h-[67px] w-[331px] items-center justify-center rounded-[20px] bg-figma-bee p-[20px] transition-transform duration-150 hover:scale-[1.01]"
          style={{ top: 451 + extra }}
        >
          <span className="figma-nowrap font-semibold text-[20px] tracking-[-0.6px] text-figma-ink">
            Ручное управление
          </span>
        </button>
      </div>
    </motion.div>
  );
}

/**
 * Animated policy toggle: 59×29 track with a sliding thumb.
 */
function PolicySwitch({
  on,
  label,
  top,
  motionOn,
  onToggle,
}: {
  on: boolean;
  label: string;
  top: number;
  motionOn: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute left-[16px] flex items-center"
      style={{ top }}
    >
      <span className="relative block h-[29px] w-[59px] overflow-hidden rounded-[14.5px]">
        <span
          className={`absolute inset-0 rounded-[14.5px] transition-colors duration-300 ${
            on ? 'bg-figma-ink' : 'bg-figma-muted'
          }`}
        />
        <motion.span
          className="absolute top-[3px] size-[23px] rounded-full bg-white"
          initial={false}
          animate={{ left: on ? 33 : 3 }}
          transition={motionOn ? { duration: 0.28, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
        />
      </span>
      <FigmaText className="figma-nowrap ml-[10px] font-medium leading-none text-[20px] text-black">
        {label}
      </FigmaText>
    </button>
  );
}

function EngineersColumn({
  engineers,
  totalCount,
  requestCount,
  totalKm,
  planLabel,
  unassignedTitle,
  unassignedReason,
  selectedEngineerId,
  searchOpen,
  searchQuery,
  motionOn,
  onSearchToggle,
  onSearchChange,
  onSelect,
  onSelectUnassigned,
}: {
  engineers: EngineerCard[];
  totalCount: number;
  requestCount: number;
  totalKm: number;
  planLabel: string;
  unassignedTitle: string;
  unassignedReason: string;
  selectedEngineerId: string | null;
  searchOpen: boolean;
  searchQuery: string;
  motionOn: boolean;
  onSearchToggle: () => void;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
  onSelectUnassigned: () => void;
}) {
  const { dy } = useArtboardStretch();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);

  return (
    <section
      className="absolute left-[180px] w-[411px] overflow-hidden rounded-[20px] bg-white"
      style={{ top: PANEL_TOP, height: PANEL_HEIGHT + dy }}
    >
      <div className="absolute left-[30px] top-[30px] z-0 flex items-center">
        <FigmaText className="figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
          {requestCountLabel(requestCount)}
        </FigmaText>
        <FigmaIcon
          src={FIGMA_ASSETS.dotEngineers}
          alt=""
          width={5}
          height={5}
          className="mx-[10px]"
        />
        <FigmaText className="figma-nowrap font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
          {totalKm} км
        </FigmaText>
      </div>
      <FigmaText className="figma-nowrap absolute left-[30px] top-[68px] z-0 font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
        {planLabel}
      </FigmaText>
      <div
        className="absolute left-[30px] right-[30px] top-[114px] z-0 h-[48px]"
        data-engineer-search
      >
        <AnimatePresence initial={false}>
          {!searchOpen ? (
            <motion.div
              key="title"
              className="absolute inset-y-0 left-0 flex items-center"
              initial={motionOn ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fadeSoft}
            >
              <FigmaText className="figma-nowrap font-semibold text-[24px] tracking-[-0.408px] text-figma-dim">
                Инженеры
              </FigmaText>
              <FigmaIcon
                src={FIGMA_ASSETS.dotEngineers}
                alt=""
                width={5}
                height={5}
                className="mx-[10px]"
              />
              <FigmaText className="figma-nowrap font-semibold text-[24px] tracking-[-0.408px] text-figma-dim">
                {totalCount}
              </FigmaText>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.div
          className="absolute right-0 top-[calc(50%-2px)] box-border flex -translate-y-1/2 items-center overflow-hidden rounded-[20px] border border-solid border-figma-ink bg-white"
          style={{
            height: SEARCH_CONTROL_SIZE,
            minHeight: SEARCH_CONTROL_SIZE,
            maxHeight: SEARCH_CONTROL_SIZE,
          }}
          initial={false}
          animate={{ width: searchOpen ? SEARCH_OPEN_WIDTH : SEARCH_CONTROL_SIZE }}
          transition={motionOn ? { duration: 0.4, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
        >
          <input
            ref={inputRef}
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Найти инженера"
            tabIndex={searchOpen ? 0 : -1}
            aria-hidden={!searchOpen}
            className="box-border h-full min-h-0 min-w-0 flex-1 border-0 bg-transparent py-0 pl-[18px] pr-[40px] font-medium leading-none text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint"
          />
          <button
            type="button"
            aria-label={searchOpen ? 'Закрыть поиск' : 'Найти инженера'}
            onClick={onSearchToggle}
            className="absolute right-0 top-0 flex items-center justify-center"
            style={{ width: SEARCH_CONTROL_SIZE, height: SEARCH_CONTROL_SIZE }}
          >
            <FigmaIcon
              src={FIGMA_ASSETS.searchPanel}
              alt=""
              width={22}
              height={22}
              className="translate-x-[1px] -translate-y-[1px]"
            />
          </button>
        </motion.div>
      </div>
      <div className="absolute inset-x-0 top-[158px] bottom-[132px] z-20 overflow-y-auto px-[30px] pt-[12px] [scrollbar-width:thin]">
        <div className="flex flex-col gap-[20px] pb-[8px]">
          <AnimatePresence initial={false}>
            {engineers.map((engineer, index) => (
              <motion.div
                key={engineer.id}
                layout
                initial={motionOn ? { opacity: 0, y: 10 } : false}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={motionOn ? springQuick : { duration: 0 }}
                className="relative"
                style={{ zIndex: index === 0 ? 30 : 10 }}
                whileHover={{ zIndex: 40 }}
              >
                <EngineerRow
                  engineer={engineer}
                  selected={engineer.id === selectedEngineerId}
                  elevate={index === 0}
                  motionOn={motionOn}
                  onSelect={() => onSelect(engineer.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {engineers.length === 0 ? (
            <p className="pt-[24px] text-center font-medium text-[16px] text-figma-muted">
              Инженер не найден
            </p>
          ) : null}
        </div>
      </div>
      <motion.button
        type="button"
        onClick={onSelectUnassigned}
        className="absolute left-[30px] z-30 flex w-[351px] flex-col items-center justify-center overflow-clip rounded-[20px] bg-figma-bee px-[29px] py-[25px]"
        style={{ top: UNASSIGNED_TOP + dy }}
        whileHover={motionOn ? { scale: 1.01 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <FigmaText className="figma-nowrap font-murs text-[20px] tracking-[0.2px] text-figma-ink">
          {unassignedTitle}
        </FigmaText>
        <FigmaText className="figma-nowrap mt-[6px] font-semibold text-[16px] tracking-[0.16px] text-figma-sub">
          {unassignedReason}
        </FigmaText>
      </motion.button>
    </section>
  );
}

function EngineerRow({
  engineer,
  selected,
  elevate,
  motionOn,
  onSelect,
}: {
  engineer: EngineerCard;
  selected: boolean;
  elevate: boolean;
  motionOn: boolean;
  onSelect: () => void;
}) {
  const progress = Math.max(
    8,
    Math.round(
      (engineer.requestCount === 0 ? 1 : engineer.doneCount / engineer.requestCount) *
        PROGRESS_TRACK,
    ),
  );

  return (
    <motion.button
      type="button"
      onClick={onSelect}
      whileHover={motionOn ? { y: -2, zIndex: 40 } : undefined}
      className={`relative box-border h-[132px] w-[351px] overflow-visible rounded-[15px] text-left transition-[box-shadow,background-color] duration-200 ease-out ${
        selected ? 'bg-figma-soft' : 'bg-transparent'
      } ${elevate ? 'z-30' : 'z-10'}`}
      style={{ boxShadow: selected ? 'inset 0 0 0 1px #727478' : 'inset 0 0 0 1px transparent' }}
    >
      <img
        alt=""
        src={FIGMA_ASSETS.avatarEngineer}
        className="absolute left-[15px] top-[20px] size-[44px] max-w-none rounded-full object-cover"
      />
      <div className="absolute left-[69px] right-[15px] top-[20px] z-20 flex items-center justify-between gap-[10px]">
        <span
          className="figma-nowrap min-w-0 flex-1 overflow-hidden font-murs text-[20px] leading-[26px] tracking-[0.1px] text-ellipsis text-black"
          title={engineer.name}
        >
          {truncateEnd(engineer.name)}
        </span>
        <FigmaText className="figma-nowrap shrink-0 font-bold text-[16px] tracking-[0.16px] text-black">
          {engineer.km} км
        </FigmaText>
      </div>
      <div className="absolute left-[69px] top-[49px] flex items-center gap-[8px] font-medium text-[16px] tracking-[-0.272px] text-figma-muted">
        <span className="figma-nowrap">{engineer.status}</span>
        <span className="size-[3px] rounded-full bg-figma-muted" />
        <span className="figma-nowrap">{engineer.requestCount} заявок</span>
      </div>
      <div className="absolute left-[15px] top-[81px] h-[8px] w-[321px] rounded-[13px] bg-figma-track" />
      <motion.div
        className={`absolute left-[15px] top-[81px] h-[8px] rounded-[13px] ${engineer.lineFailed ? 'bg-figma-cancel' : engineer.doneCount === engineer.requestCount ? 'bg-figma-done' : 'bg-figma-ink'}`}
        initial={false}
        animate={{ width: progress }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      />
      <FigmaText className="figma-nowrap absolute left-[15px] top-[104px] font-semibold text-[16px] tracking-[-0.272px] text-figma-muted">
        {engineer.shift}
      </FigmaText>
      <FigmaText className="figma-nowrap absolute right-[15px] top-[104px] font-semibold text-[16px] tracking-[-0.272px] text-figma-muted">
        {engineer.lineLabel ?? `выполнено ${engineer.doneCount}/${engineer.requestCount}`}
      </FigmaText>
    </motion.button>
  );
}

function MapCard({
  snapshot,
  selectedEngineerId,
  selectedRequestId,
  progressByEngineer,
  completedByEngineer,
  handoffs,
  frame,
  regionLabel,
  regions,
  selectedRegion,
  regionOpen,
  motionOn,
  onSelectRequest,
  onToggleRegion,
  onSelectRegion,
  token,
}: {
  snapshot: ReturnType<typeof useDashboard>['snapshot'];
  selectedEngineerId: string | null;
  selectedRequestId: string | null;
  progressByEngineer: NonNullable<Parameters<typeof DayMap>[0]['progressByEngineer']>;
  completedByEngineer: ReadonlyMap<string, number>;
  handoffs: NonNullable<Parameters<typeof DayMap>[0]['handoffs']>;
  frame: { left: number; top: number; width: number; height: number };
  regionLabel: string;
  regions: { id: RegionSelection; label: string }[];
  selectedRegion: RegionSelection;
  regionOpen: boolean;
  motionOn: boolean;
  onSelectRequest: (requestId: string) => void;
  onToggleRegion: () => void;
  onSelectRegion: (id: RegionSelection) => void;
  token: string | null;
}) {
  return (
    <motion.section
      className="absolute overflow-visible rounded-[20px] bg-white"
      initial={false}
      animate={frame}
      transition={motionOn ? { duration: 0.45, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <div className="absolute inset-0 overflow-clip rounded-[20px]">
        {snapshot ? (
          <DayMap
            snapshot={snapshot}
            selectedEngineerId={selectedEngineerId}
            selectedRequestId={selectedRequestId}
            progressByEngineer={progressByEngineer}
            completedByEngineer={completedByEngineer}
            handoffs={handoffs}
            onSelectRequest={onSelectRequest}
          />
        ) : (
          <motion.img
            alt="Карта Москвы"
            src={FIGMA_ASSETS.map}
            className="absolute inset-0 size-full max-w-none object-cover"
            initial={motionOn ? { opacity: 0.72, scale: 1.012 } : false}
            animate={{ opacity: 1, scale: 1 }}
            transition={fadeSoft}
          />
        )}
      </div>
      <WeatherBadge token={token} />
      <RegionSwitch
        open={regionOpen}
        label={regionLabel}
        regions={regions}
        selectedId={selectedRegion}
        motionOn={motionOn}
        onToggle={onToggleRegion}
        onSelect={onSelectRegion}
      />
    </motion.section>
  );
}

function RouteCard({
  engineer,
  progress,
  motionOn,
  onSelectRequest,
  handoffs,
  engineerNames,
}: {
  engineer: EngineerCard;
  progress: LiveRouteProgress | null;
  motionOn: boolean;
  onSelectRequest: (requestId: string) => void;
  handoffs: readonly HandoffView[];
  engineerNames: ReadonlyMap<string, string>;
}) {
  const { dx, dy } = useArtboardStretch();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const skipClick = useRef(false);
  const liveMarker = routeProgressMarker(engineer.stops, progress);
  const drag = useRef<{
    kind: 'panel' | 'thumb';
    startX: number;
    startScroll: number;
    scale: number;
    overflow: number;
    track: number;
    thumbWidth: number;
  } | null>(null);
  const [thumb, setThumb] = useState({ left: 174, width: 321, visible: false });
  const [grabbing, setGrabbing] = useState(false);
  const [selectedHandoff, setSelectedHandoff] = useState<HandoffView | null>(null);

  const updateThumb = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0 || engineer.stops.length === 0) {
      setThumb({ left: 174, width: 321, visible: false });
      return;
    }
    const track = 691;
    const width = Math.max(96, Math.round((el.clientWidth / el.scrollWidth) * track));
    const left = 30 + (el.scrollLeft / overflow) * (track - width);
    setThumb({ left, width, visible: true });
  }, [engineer.stops.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const refresh = () => {
      el.style.overflowX = 'hidden';
      void el.offsetWidth;
      el.style.overflowX = 'auto';
      updateThumb();
    };
    refresh();
    const frame = window.requestAnimationFrame(refresh);
    const later = window.setTimeout(refresh, 420);
    el.addEventListener('scroll', updateThumb, { passive: true });
    const observer = new ResizeObserver(updateThumb);
    observer.observe(el);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(later);
      el.removeEventListener('scroll', updateThumb);
      observer.disconnect();
    };
  }, [updateThumb]);

  const beginDrag = (kind: 'panel' | 'thumb', clientX: number) => {
    const el = scrollerRef.current;
    if (!el) return false;
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow <= 0) return false;
    const scale = el.getBoundingClientRect().width / el.offsetWidth || 1;
    skipClick.current = false;
    drag.current = {
      kind,
      startX: clientX,
      startScroll: el.scrollLeft,
      scale,
      overflow,
      track: 691,
      thumbWidth: thumb.width,
    };
    setGrabbing(true);
    return true;
  };

  useEffect(() => {
    if (!grabbing) return;
    const onMove = (event: PointerEvent) => {
      const state = drag.current;
      const el = scrollerRef.current;
      if (!state || !el) return;
      const dx = (event.clientX - state.startX) / state.scale;
      if (Math.abs(dx) > 4) skipClick.current = true;
      if (state.kind === 'thumb') {
        const travel = state.track - state.thumbWidth;
        el.scrollLeft = state.startScroll + (dx / Math.max(1, travel)) * state.overflow;
      } else {
        el.scrollLeft = state.startScroll - dx;
      }
    };
    const onUp = () => {
      drag.current = null;
      setGrabbing(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [grabbing]);

  return (
    <motion.section
      className={`absolute overflow-hidden rounded-[20px] bg-white ${
        grabbing ? 'cursor-grabbing select-none' : thumb.visible ? 'cursor-grab' : ''
      }`}
      style={{
        left: MAP_LEFT,
        top: ROUTE_CARD_TOP + dy,
        width: MAP_COMPACT_WIDTH + dx,
        height: ROUTE_CARD_HEIGHT,
      }}
      initial={motionOn ? { opacity: 0, y: 20 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={motionOn ? { opacity: 0, y: 28 } : undefined}
      transition={motionOn ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement).closest('[data-route-thumb]')) return;
        if (beginDrag('panel', event.clientX)) event.preventDefault();
      }}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={engineer.id}
          initial={motionOn ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          exit={motionOn ? { opacity: 0, y: -8 } : undefined}
          transition={fadeSoft}
          className="absolute inset-0"
        >
          <FigmaText
            className="figma-text-keep-descenders figma-nowrap pointer-events-none absolute left-[30px] right-[30px] top-[30px] overflow-hidden font-bold text-[28px] tracking-[-0.476px] text-ellipsis text-figma-ink"
            title={`Маршрут ${engineer.name}`}
          >
            Маршрут {truncateEnd(engineer.name, 22)}
          </FigmaText>
          <FigmaText className="figma-text-keep-descenders figma-nowrap pointer-events-none absolute left-[30px] top-[68px] font-semibold text-[18px] tracking-[-0.306px] text-figma-muted">
            {engineer.routeUpdated}
          </FigmaText>
          <div
            ref={scrollerRef}
            className="route-scroll absolute inset-x-0 top-[110px] bottom-[22px] overflow-x-auto"
          >
            <div
              className="relative px-[30px]"
              style={{ width: 60 + engineer.stops.length * ROUTE_STOP_WIDTH }}
            >
              <div
                className="absolute top-[19px] h-[3px] bg-figma-ink"
                style={{
                  left: ROUTE_LINE_LEFT,
                  width: Math.max(0, (engineer.stops.length - 1) * ROUTE_STOP_WIDTH),
                }}
              />
              {liveMarker ? (
                <div
                  className="absolute top-[19px] h-[3px] bg-figma-bee"
                  style={{
                    left: ROUTE_LINE_LEFT + liveMarker.fromIndex * ROUTE_STOP_WIDTH,
                    width: (liveMarker.toIndex - liveMarker.fromIndex) * ROUTE_STOP_WIDTH,
                  }}
                />
              ) : null}
              <div className="flex">
                {engineer.stops.map((stop, index) => (
                  <RouteStopTopic
                    key={`${engineer.id}-${stop.requestId ?? stop.place}-${stop.time}`}
                    stop={stop}
                    index={index}
                    motionOn={motionOn}
                    onSelectRequest={(requestId) => {
                      if (skipClick.current) return;
                      onSelectRequest(requestId);
                    }}
                    onSelectHandoff={(handoffId) => {
                      if (skipClick.current) return;
                      setSelectedHandoff(handoffs.find((item) => item.id === handoffId) ?? null);
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
      {selectedHandoff ? (
        <div className="absolute left-[30px] right-[30px] top-[158px] z-20 rounded-[16px] border-2 border-[#2563EB] bg-white px-[16px] py-[10px] text-[14px] text-figma-ink shadow-lg">
          <div className="flex items-center justify-between gap-3">
            <strong>Передача оборудования</strong>
            <button
              type="button"
              onClick={() => setSelectedHandoff(null)}
              aria-label="Закрыть детали передачи"
            >
              ×
            </button>
          </div>
          <p className="mt-1 text-figma-muted">
            {engineerNames.get(selectedHandoff.donorEngineerId) ?? selectedHandoff.donorEngineerId}
            {' → '}
            {engineerNames.get(selectedHandoff.receiverEngineerId) ??
              selectedHandoff.receiverEngineerId}
          </p>
          <p className="mt-1 text-figma-muted">{handoffItemsLabel(selectedHandoff.items)}</p>
        </div>
      ) : null}
    </motion.section>
  );
}

function RouteStopTopic({
  stop,
  index,
  motionOn,
  onSelectRequest,
  onSelectHandoff,
}: {
  stop: RouteStop;
  index: number;
  motionOn: boolean;
  onSelectRequest: (requestId: string) => void;
  onSelectHandoff: (handoffId: string) => void;
}) {
  const clickable = Boolean(stop.requestId || stop.handoffId);
  const handoff = stop.kind === 'handoff';
  return (
    <motion.button
      type="button"
      disabled={!clickable}
      onClick={() => {
        if (stop.handoffId) onSelectHandoff(stop.handoffId);
        else if (stop.requestId) onSelectRequest(stop.requestId);
      }}
      className={`relative shrink-0 text-left ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
      style={{ width: ROUTE_STOP_WIDTH }}
      initial={motionOn ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...fadeSoft, delay: index * 0.04 }}
    >
      <span
        className={`absolute top-[10px] rounded-full ${handoff ? 'bg-[#2563EB]' : stop.failed || stop.status === 'отменено' ? 'bg-figma-cancel' : stop.active ? 'bg-figma-bee ring-4 ring-figma-ink' : stop.completed ? 'bg-figma-done' : 'bg-figma-ink'}`}
        style={{ left: ROUTE_DOT_LEFT, width: ROUTE_DOT_SIZE, height: ROUTE_DOT_SIZE }}
      />
      <FigmaText className="figma-nowrap absolute left-0 top-[46px] w-[240px] text-center font-semibold text-[24px] tracking-[-0.408px] text-black">
        {stop.time}
      </FigmaText>
      <p className="absolute left-0 top-[78px] h-[44px] w-[240px] overflow-hidden text-center font-semibold text-[18px] leading-[22px] tracking-[-0.306px] text-figma-muted line-clamp-2">
        {stop.place}
      </p>
      <FigmaText
        className={`absolute left-0 top-[126px] w-[240px] text-center font-semibold text-[16px] tracking-[-0.272px] ${
          stop.failed || stop.status === 'отменено'
            ? 'text-figma-cancel uppercase'
            : isCompletedStop(stop.status)
              ? 'text-figma-done'
              : 'text-figma-hint'
        }`}
      >
        {handoff ? 'ПЕРЕДАЧА' : routeStopStatusLabel(stop.status)}
      </FigmaText>
    </motion.button>
  );
}

function handoffItemsLabel(items: HandoffView['items']): string {
  const labels = [
    items.router ? `роутер ×${items.router}` : null,
    items.set_top_box ? `ТВ-приставка ×${items.set_top_box}` : null,
    items.smart_speaker ? `умная колонка ×${items.smart_speaker}` : null,
  ].filter((item): item is string => item !== null);
  return labels.join(', ') || 'Оборудование не указано';
}

const FACT_ICON = {
  skills: '/figma/engineer-skills.svg',
  transport: '/figma/transport.svg',
  equipment: '/figma/equipment.svg',
  window: '/figma/time-window.svg',
  lunch: '/figma/lunch.svg',
  route: '/figma/graph-route.svg',
} as const;

function DetailPanel({
  mode,
  request,
  engineer,
  explanation,
  token,
  roster,
  motionOn,
  onClose,
  onOpenEngineer,
}: {
  mode: 'plan' | 'request';
  request: RequestView | null;
  engineer: EngineerView | null;
  explanation: CaseExplanation | null;
  token: string | null;
  roster: ReadonlyArray<{
    name: string;
    skills: readonly string[];
    transport: string;
    availability: string | null;
  }>;
  motionOn: boolean;
  onClose: () => void;
  onOpenEngineer?: () => void;
}) {
  const { dx, dy } = useArtboardStretch();
  const [aiOn, setAiOn] = useState(false);
  const [largeOn, setLargeOn] = useState(false);
  const urgency = request ? requestUrgency(request) : null;
  const equipment = request
    ? request.requiredEquipment
      ? requestEquipmentLabel(request.requiredEquipment)
      : 'Без оборудования'
    : null;
  const assignment =
    request == null
      ? null
      : request.assignmentState === 'unassigned' || request.assignmentState === 'pending'
        ? 'Не назначена'
        : 'Назначена';

  return (
    <motion.aside
      className="absolute w-[484px] overflow-hidden rounded-[20px] bg-figma-ink"
      style={{ left: DETAIL_PANEL_LEFT + dx, top: PANEL_TOP, height: PANEL_HEIGHT + dy }}
      initial={motionOn ? { opacity: 0, x: 28 } : false}
      animate={{ opacity: 1, x: 0 }}
      exit={motionOn ? { opacity: 0, x: 36 } : undefined}
      transition={motionOn ? { duration: 0.38, ease: [0.22, 1, 0.36, 1] } : { duration: 0 }}
    >
      <motion.button
        type="button"
        aria-label="Закрыть панель"
        onClick={onClose}
        className="absolute right-[16px] top-[16px] z-20 flex items-center justify-center rounded-full bg-white"
        style={{ width: CLOSE_PANEL_SIZE, height: CLOSE_PANEL_SIZE }}
        whileHover={motionOn ? { scale: 1.12 } : undefined}
        whileTap={motionOn ? { scale: 0.94 } : undefined}
        transition={{ duration: 0.16 }}
      >
        <X size={22} strokeWidth={2.25} className="text-figma-ink" />
      </motion.button>
      <div
        className={`absolute inset-x-0 top-0 overflow-y-auto px-[27px] pt-[24px] [scrollbar-width:thin] ${
          mode === 'plan' ? 'bottom-[110px]' : 'bottom-[24px]'
        }`}
      >
        {mode === 'request' && request ? (
          <div className="pr-[52px]">
            <FigmaText className="font-murs text-[32px] leading-[36px] tracking-[-0.544px] text-white">
              {request.workTypeTitle || 'Заявка'}
            </FigmaText>
            <Copyable
              value={shortRequestId(request.id)}
              label="Скопировать номер заявки"
              className="mt-[8px] text-left"
            >
              <p
                className="font-semibold text-[20px] tracking-[-0.34px] text-white/60"
                title={request.id}
              >
                {shortRequestId(request.id)}
              </p>
            </Copyable>
            <div className="mt-[16px] flex flex-wrap gap-[12px]">
              {assignment ? <PanelTag label={assignment} /> : null}
              {urgency ? <PanelTag label={urgency.label} tone={urgency.tone} /> : null}
              {equipment ? <PanelTag label={equipment} /> : null}
            </div>
            <Copyable
              value={request.addressText}
              label="Скопировать адрес"
              className="mt-[16px] flex min-h-[67px] w-full items-center rounded-[20px] bg-figma-dim px-[20px] py-[16px] text-left transition-colors hover:bg-white/10"
            >
              <p className="font-medium text-[20px] leading-[24px] tracking-[-0.6px] text-white">
                {request.addressText}
              </p>
            </Copyable>
          </div>
        ) : engineer ? (
          <div className="pr-[52px]">
            <FigmaText className="font-murs text-[32px] leading-[36px] tracking-[-0.544px] text-white">
              {engineer.displayName}
            </FigmaText>
            <p
              className={`mt-[8px] font-semibold text-[18px] tracking-[-0.3px] ${
                engineer.email ? 'text-white/60' : 'invisible'
              }`}
              aria-hidden={engineer.email ? undefined : true}
            >
              {engineer.email || '\u00a0'}
            </p>
          </div>
        ) : (
          <div className="h-[36px]" />
        )}
        {mode === 'request' ? (
          <RequestReasons
            aiOn={aiOn}
            largeOn={largeOn}
            motionOn={motionOn}
            token={token}
            context={{
              explanation,
              roster: (roster ?? []).slice(0, 8),
              request: request
                ? {
                    id: request.id,
                    address: request.addressText,
                    windowStartAt: request.windowStartAt,
                    windowEndAt: request.windowEndAt,
                    skill: request.requiredSkill,
                    status: request.assignmentState,
                  }
                : null,
              engineer: engineer
                ? {
                    name: engineer.displayName,
                    skills: engineer.skills,
                    transport: engineer.transportType,
                  }
                : null,
            }}
            explanation={explanation}
            durationLabel={request ? formatDurationMin(request.serviceDurationSec) : '—'}
            onToggleAi={() => setAiOn((value) => !value)}
            onToggleLarge={() => setLargeOn((value) => !value)}
          />
        ) : (
          <IconFactCard title="Факты" facts={explanation?.iconFacts ?? []} />
        )}
      </div>
      {mode === 'plan' && engineer ? (
        <div className="absolute inset-x-[27px] bottom-[24px] flex gap-[12px]">
          <button
            type="button"
            onClick={onOpenEngineer}
            className="h-[52px] flex-1 rounded-[16px] bg-white font-semibold text-[16px] text-figma-ink"
          >
            К инженеру
          </button>
          <button
            type="button"
            disabled
            title="Скоро"
            className="h-[52px] flex-1 cursor-not-allowed rounded-[16px] bg-white/15 font-semibold text-[16px] text-white/45"
          >
            Написать
          </button>
        </div>
      ) : null}
    </motion.aside>
  );
}

function RequestReasons({
  aiOn,
  largeOn,
  motionOn,
  token,
  context,
  explanation,
  durationLabel,
  onToggleAi,
  onToggleLarge,
}: {
  aiOn: boolean;
  largeOn: boolean;
  motionOn: boolean;
  token: string | null;
  context: unknown;
  explanation: CaseExplanation | null;
  durationLabel: string;
  onToggleAi: () => void;
  onToggleLarge: () => void;
}) {
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const packed = JSON.stringify(context);
  useEffect(() => {
    if (!aiOn || !token) {
      setAiText(null);
      setAiReady(false);
      return;
    }
    let cancelled = false;
    setAiReady(false);
    void explainWithAi(token, 'reasons', JSON.parse(packed) as unknown)
      .then((result) => {
        if (!cancelled) setAiText(result.text);
      })
      .catch(() => {
        if (!cancelled) setAiText(null);
      })
      .finally(() => {
        if (!cancelled) setAiReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [aiOn, token, packed]);
  return (
    <div className="mt-[16px]">
      <div className="flex min-h-[216px] w-full flex-col rounded-[20px] bg-figma-dim px-[20px] py-[22px]">
        <div className="flex items-center justify-between gap-[8px]">
          <FigmaText
            className={`font-medium text-[28px] tracking-[-0.84px] ${
              aiOn ? 'panel-ai-fill client-ai-text figma-text-uncropped' : 'text-white'
            }`}
          >
            {aiOn ? 'Причины AI' : 'Причины'}
          </FigmaText>
          <LayoutGroup>
            <div className="flex items-center">
              <motion.div layout={motionOn} transition={{ duration: 0.32, ease: slideEase }}>
                <ReasonIconButton
                  label={aiOn ? 'Обычные причины' : 'Объяснить с AI'}
                  motionOn={motionOn}
                  onClick={onToggleAi}
                >
                  {aiOn ? (
                    <TintIcon src="/figma/explain-default.svg" color="#ffffff" size={18} />
                  ) : (
                    <AiGlyph />
                  )}
                </ReasonIconButton>
              </motion.div>
              <AnimatePresence initial={false}>
                {aiOn ? null : (
                  <motion.span
                    key="size"
                    className="inline-flex overflow-hidden"
                    initial={motionOn ? { width: 0, opacity: 0, marginLeft: 0 } : false}
                    animate={{ width: 36, opacity: 1, marginLeft: 8 }}
                    exit={motionOn ? { width: 0, opacity: 0, marginLeft: 0 } : undefined}
                    transition={{ duration: 0.32, ease: slideEase }}
                  >
                    <ReasonIconButton
                      label={largeOn ? 'Коротко' : 'Подробнее'}
                      motionOn={motionOn}
                      onClick={onToggleLarge}
                    >
                      <TintIcon
                        src={largeOn ? '/figma/short-facts.svg' : '/figma/large-facts.svg'}
                        color="#ffffff"
                        size={18}
                      />
                    </ReasonIconButton>
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </LayoutGroup>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={aiOn ? (aiReady ? 'ai-text' : 'ai-search') : largeOn ? 'large' : 'short'}
            initial={motionOn ? { opacity: 0, y: 6 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={motionOn ? { opacity: 0, y: -6 } : undefined}
            transition={{ duration: 0.22 }}
          >
            {aiOn ? (
              aiReady ? (
                <p className="mt-[12px] font-medium text-[18px] leading-[24px] text-white/70">
                  {aiText ??
                    'Текстовый разбор пока не подключён. Причины решения остаются обычными, без выдуманного текста.'}
                </p>
              ) : (
                <AiSearchLines />
              )
            ) : (
              <IconFactList facts={explanation?.iconFacts ?? []} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      {largeOn && !aiOn ? (
        <>
          <div className="mt-[16px] flex min-h-[160px] w-full flex-col rounded-[20px] bg-figma-dim px-[20px] py-[22px]">
            <FigmaText className="font-medium text-[28px] tracking-[-0.84px] text-white">
              Как влияет
            </FigmaText>
            <p className="mt-[12px] font-medium text-[18px] leading-[24px] text-white/70">
              {explanation?.influence || 'Нет объяснения влияния.'}
            </p>
          </div>
          <div className="mt-[16px] flex min-h-[67px] w-full items-center rounded-[20px] bg-figma-dim px-[20px] py-[16px]">
            <p className="font-medium text-[20px] leading-[24px] text-white">
              {explanation?.result || durationLabel}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ReasonIconButton({
  label,
  motionOn,
  onClick,
  children,
}: {
  label: string;
  motionOn: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-[36px] items-center justify-center rounded-full bg-white/10"
      whileHover={motionOn ? { scale: 1.08, backgroundColor: 'rgba(255,255,255,0.18)' } : undefined}
      whileTap={motionOn ? { scale: 0.92 } : undefined}
      transition={{ duration: 0.16 }}
    >
      {children}
    </motion.button>
  );
}

function IconFactCard({
  title,
  facts,
}: {
  title: string;
  facts: NonNullable<CaseExplanation['iconFacts']>;
}) {
  return (
    <div className="mt-[16px] flex min-h-[216px] w-full flex-col rounded-[20px] bg-figma-dim px-[20px] py-[22px]">
      <FigmaText className="font-medium text-[28px] tracking-[-0.84px] text-white">
        {title}
      </FigmaText>
      <IconFactList facts={facts} className="mt-[22px]" />
    </div>
  );
}

/** Black sparkle painted with the same moving gradient as the client AI mark. */
function AiGlyph() {
  return (
    <span
      aria-hidden
      className="panel-ai-fill block size-[18px]"
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
  );
}

/** Placeholder bars while a write-up would still be generating. */
function AiSearchLines() {
  const widths = ['92%', '74%', '86%', '58%'];
  return (
    <div className="mt-[16px] space-y-[12px]" aria-hidden>
      {widths.map((width) => (
        <div
          key={width}
          className="h-[14px] overflow-hidden rounded-full bg-white/10"
          style={{ width }}
        >
          <div className="ai-reason-shimmer h-full w-full" />
        </div>
      ))}
    </div>
  );
}

function IconFactList({
  facts,
  className = 'mt-[12px]',
}: {
  facts: NonNullable<CaseExplanation['iconFacts']>;
  className?: string;
}) {
  if (facts.length === 0) {
    return (
      <p className={`${className} font-medium text-[18px] leading-[24px] text-white/70`}>
        Нет причин по этому выбору.
      </p>
    );
  }
  return (
    <ul className={`${className} space-y-[10px]`}>
      {facts.map((fact) => (
        <li key={`${fact.icon}:${fact.text}`} className="flex items-center gap-[10px]">
          <TintIcon src={FACT_ICON[fact.icon]} color="#ffffff" size={20} />
          <span className="font-medium text-[18px] leading-[24px] tracking-[-0.3px] text-white/70">
            {fact.text.replace(/\.+$/u, '')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PanelTag({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'urgent' | 'emergency';
}) {
  const textClass = tone === 'emergency' ? 'text-figma-danger' : 'text-figma-ink';
  return (
    <div className="flex items-center justify-center rounded-[20px] bg-figma-track px-[20px] py-[12px]">
      <FigmaText className={`figma-nowrap font-medium text-[20px] tracking-[-0.34px] ${textClass}`}>
        {label}
      </FigmaText>
    </div>
  );
}
