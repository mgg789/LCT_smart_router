import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getMcpSettings, updateDispatcherSettings } from '../api/client';
import { loadPersonalPolicy, type PersonalPolicyProfile } from '../api/personal-policy';
import type { PlanDelta, PolicyId } from '../api/types';
import { ALL_REGIONS, type RegionSelection } from '../domain/regions';
import { clearAssistantSessions } from '../hooks/useAssistantChat';
import { useDashboard } from '../hooks/useDashboard';
import { formatClock } from '../lib/time';
import { AddEntityModal } from './AddEntityModal';
import { AlertsView } from './AlertsView';
import { useArtboardScale } from './artboardScale';
import { ConfirmDangerModal } from './ConfirmDangerModal';
import type { DangerActionId } from './confirmPhrase';
import { DashboardAi, DashboardChats } from './DashboardAssist';
import {
  AddEntityButton,
  NotificationControl,
  PlanMetricsButton,
  PolicyControl,
  SidebarNav,
  UserMenu,
} from './DashboardHeaderControls';
import { DataUploadModal } from './DataUploadModal';
import { DispatcherAuthPage } from './DispatcherAuthPage';
import { DispatcherDayResults } from './DispatcherDayResults';
import {
  isNavLocked,
  stackSlideDir,
  stackSlideEnter,
  stackSlideExit,
  stackViewKey,
} from './dashboardSlide';
import { EngineerColumn } from './EngineerColumn';
import { EngineersView } from './EngineersView';
import { FIGMA_ARTBOARD, type NavItemId, type NotificationTone } from './fixtures';
import { nextRouterSettings, policyLabel } from './fromSnapshot';
import { ManualPlanningProvider, openManualPlanning } from './ManualPlanning';
import { MapCard, RouteCard } from './MapRoute';
import { McpAgentIndicator } from './McpAgentIndicator';
import { PersonalPolicyDialog } from './PersonalPolicyDialog';
import {
  type PlanHistoryAnchor,
  type PlanHistorySelection,
  PlanHistorySelector,
} from './PlanHistorySelector';
import { PlanMetricsModal } from './PlanMetricsModal';
import { PolicyComparisonView } from './PolicyComparisonView';
import { FigmaText } from './primitives';
import { ReplanDeltaCard } from './ReplanDeltaCard';
import { RequestDetails } from './RequestDetails';
import { RequestDetailView } from './RequestDetailView';
import { RequestsView } from './RequestsView';
import { SettingsModal, type SettingsTab } from './SettingsModal';
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
import { useDashboardPresentation } from './useDashboardPresentation';
import { WelcomeScreen } from './WelcomeScreen';
import { WorsenModal } from './WorsenModal';
import {
  clearWorkDayStarted,
  hasStartedWorkDay,
  markWorkDayStarted,
  moscowWorkDate,
  shouldShowStartWelcome,
} from './welcomeDay';

const HEADER_LIFT = 16;
const DATE_TOP = 100 - HEADER_LIFT;
const PANEL_TOP = 154 - HEADER_LIFT;
const PANEL_HEIGHT = 893 + HEADER_LIFT;
const MAP_COMPACT = { left: 623, top: PANEL_TOP, width: 751, height: 582 + HEADER_LIFT };
const MAP_REQUEST_ONLY = { left: 623, top: PANEL_TOP, width: 751, height: PANEL_HEIGHT };
const MAP_EXPANDED = { left: 623, top: PANEL_TOP, width: 1267, height: PANEL_HEIGHT };
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
  const [personalPolicy, setPersonalPolicy] = useState<PersonalPolicyProfile>(null);
  const [personalPolicyOpen, setPersonalPolicyOpen] = useState(false);
  const [policyAiMessage, setPolicyAiMessage] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!dash.token) {
      setPersonalPolicy(null);
      return;
    }
    if (!policyOpen) return;
    void loadPersonalPolicy(dash.token)
      .then(({ profile }) => {
        if (!cancelled) setPersonalPolicy(profile);
      })
      .catch(() => {
        if (!cancelled) setPersonalPolicy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dash.token, policyOpen]);
  const [activeNav, setActiveNav] = useState<NavItemId>('day');
  const [stackNav, setStackNav] = useState<NavItemId>('day');
  const [settledPane, setSettledPane] = useState('main');
  const [stackDir, setStackDir] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [reviewDelta, setReviewDelta] = useState<PlanDelta | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySelection, setHistorySelection] = useState<PlanHistorySelection>('current');
  const [historyError, setHistoryError] = useState<string | null>(null);
  const artboardRef = useRef<HTMLDivElement>(null);
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
    const artboard = artboardRef.current;
    if (!artboard || !historyOpen || !dash.previousPlan) return;
    const dialog = artboard.querySelector<HTMLElement>('[data-plan-history-dialog]');
    if (!dialog) return;

    // Keep the map visible while making every other direct artboard surface inert.
    const inertNodes = Array.from(artboard.children).filter(
      (node) =>
        !(node instanceof HTMLElement && node.hasAttribute('data-plan-history-dialog')) &&
        !(node instanceof HTMLElement && node.hasAttribute('data-plan-history-veil')),
    );
    const previouslyInert = new Map<Element, boolean>();
    for (const node of inertNodes) {
      previouslyInert.set(node, node.hasAttribute('inert'));
      node.setAttribute('inert', '');
    }

    dialog.focus();
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        dialog.focus();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!dialog.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        dialog.focus();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dialog.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [data-plan-history-tooltip]'),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const current = document.activeElement;
      const index = focusable.indexOf(current as HTMLElement);
      const next = event.shiftKey
        ? focusable[(index <= 0 ? focusable.length : index) - 1]
        : focusable[(index + 1) % focusable.length];
      event.preventDefault();
      next?.focus();
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('keydown', onKeyDown, true);
      for (const [node, wasInert] of previouslyInert) {
        if (wasInert) node.setAttribute('inert', '');
        else node.removeAttribute('inert');
      }
    };
  }, [dash.previousPlan, historyOpen]);

  useEffect(() => {
    const syncWelcome = () => {
      if (!hasStartedWorkDay(window.localStorage, moscowWorkDate())) {
        setWelcomeOpen(true);
      }
    };
    const timer = window.setInterval(syncWelcome, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const presentation = useDashboardPresentation(dash, selectedRegion, searchQuery);
  const {
    visibleSnapshot,
    regions,
    view,
    roster,
    liveProgress,
    visibleEngineers,
    liveCompleted,
    engineerNames,
    selectedEngineer,
    panelMode,
    showRightPanel,
    showRouteCard,
    regionLabel,
    panelExplanation,
  } = presentation;

  useEffect(() => {
    if (selectedRegion !== ALL_REGIONS && !regions.some((region) => region.id === selectedRegion)) {
      setSelectedRegion(ALL_REGIONS);
      dash.clearFocus();
    }
  }, [dash.clearFocus, regions, selectedRegion]);
  const mapFrame = !showRightPanel ? MAP_EXPANDED : showRouteCard ? MAP_COMPACT : MAP_REQUEST_ONLY;
  const historyAnchor: PlanHistoryAnchor = {
    left: mapFrame.left + mapFrame.width / 2,
    bottom: FIGMA_ARTBOARD.height - mapFrame.top - mapFrame.height + 28,
  };
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
  const strictTimeWindowsOn = dash.snapshot?.routerSettings?.strictTimeWindows ?? false;
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
  const applyStrictTimeWindows = () => {
    if (!dash.snapshot) return;
    dash.applyRoutingSettings(
      dash.snapshot.policyId,
      nextRouterSettings(dash.snapshot, {
        strictTimeWindows: !(dash.snapshot.routerSettings?.strictTimeWindows ?? false),
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

  const scale = useArtboardScale();
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
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-figma-canvas">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Outside-pointer dismissal supplements the menus' keyboard-accessible controls; this artboard is not an extra focus target. */}
      <div
        ref={artboardRef}
        className="relative shrink-0 bg-figma-canvas"
        data-name="MAIN"
        style={{
          width: FIGMA_ARTBOARD.width,
          height: FIGMA_ARTBOARD.height,
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
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
        <ManualPlanningProvider
          token={dash.source === 'live' ? dash.token : null}
          snapshot={dash.snapshot}
          refresh={dash.refresh}
        >
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
            onOpenPolicyComparison={() => {
              setMetricsOpen(false);
              setStackDir(stackSlideDir(stackNav, 'policy'));
              setStackNav('policy');
              setActiveNav('policy');
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
            onRegionCreated={dash.refresh}
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
            strictTimeWindowsOn={strictTimeWindowsOn}
            ordinaryReplanningDisabled={dash.snapshot?.ordinaryReplanningDisabled ?? false}
            replanningSaving={dash.savingReplanning || dash.source !== 'live'}
            onOrdinaryReplanningToggle={() => void dash.toggleOrdinaryReplanning()}
            motionOn={motionOn}
            onToggle={() => {
              setUserMenuOpen(false);
              setAddOpen(false);
              setPolicyOpen((value) => !value);
            }}
            personalConfigured={personalPolicy !== null}
            personalTitle={personalPolicy?.title}
            onEditPersonal={() => {
              setPolicyOpen(false);
              setPersonalPolicyOpen(true);
            }}
            onSelect={(id) => {
              if (id === 'personal' && !personalPolicy) {
                setPolicyOpen(false);
                setPersonalPolicyOpen(true);
              } else applyPolicy(id);
            }}
            onLunchToggle={applyLunch}
            onTrafficToggle={applyTraffic}
            onMetroToggle={applyMetro}
            onEquipmentTransfersToggle={applyEquipmentTransfers}
            onStrictTimeWindowsToggle={applyStrictTimeWindows}
            manualMode={dash.snapshot?.plan.mode === 'manual'}
            onManualMode={() => {
              if (!dash.snapshot) return;
              setPolicyOpen(false);
              openManualPlanning('mode');
            }}
          />
          <PersonalPolicyDialog
            open={personalPolicyOpen}
            motionOn={motionOn}
            onClose={() => setPersonalPolicyOpen(false)}
            onContinue={() => {
              setPersonalPolicyOpen(false);
              setStackDir(stackSlideDir(stackNav, 'ai'));
              setStackNav('ai');
              setActiveNav('ai');
              setPolicyAiMessage({ id: crypto.randomUUID(), text: 'Поменяй мою личную политику' });
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
            scale={scale}
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
            token={dash.token}
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
            manualMode={dash.snapshot?.plan.mode === 'manual'}
            open={userMenuOpen}
            covered={notifOpen}
            hasPreviousPlan={dash.previousPlan !== null}
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
            onOpenPreviousPlan={() => {
              setActiveNav('day');
              setStackDir(stackSlideDir(stackNav, 'day'));
              setStackNav('day');
              setUserMenuOpen(false);
              setPolicyOpen(false);
              setNotifOpen(false);
              setHistorySelection('current');
              setHistoryError(null);
              setHistoryOpen(true);
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
          <AnimatePresence>
            {historyOpen && dash.previousPlan ? (
              <>
                <motion.div
                  key="plan-history-veil"
                  data-plan-history-veil
                  aria-hidden="true"
                  className="absolute inset-0 z-[120] bg-figma-ink/10"
                  initial={motionOn ? { opacity: 0 } : false}
                  animate={{ opacity: 1 }}
                  exit={motionOn ? { opacity: 0 } : undefined}
                  transition={motionOn ? { duration: 0.2 } : { duration: 0 }}
                  onMouseDown={(event) => event.stopPropagation()}
                />
                <PlanHistorySelector
                  previous={dash.previousPlan}
                  currentRevision={dash.snapshot?.plan.plan?.revision ?? null}
                  selection={historySelection}
                  canRestore={dash.canRejectDelta}
                  busy={dash.busy}
                  motionOn={motionOn}
                  error={historyError}
                  restoreUnavailableReason={dash.restoreUnavailableReason}
                  anchor={historyAnchor}
                  onSelect={setHistorySelection}
                  onChoose={async () => {
                    if (historySelection === 'previous') {
                      if (!dash.canRejectDelta) return;
                      setHistoryError(null);
                      if (await dash.rejectDelta()) setHistoryOpen(false);
                      else
                        setHistoryError(
                          'Не удалось восстановить план. Повторите выбор или выберите текущий.',
                        );
                      return;
                    }
                    setHistoryOpen(false);
                  }}
                />
              </>
            ) : null}
          </AnimatePresence>
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
                    initialMessage={policyAiMessage ?? undefined}
                    onInitialMessageSent={() => setPolicyAiMessage(null)}
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
                    onUpdateProfile={dash.updateEngineerProfile}
                    onDeleteEngineer={dash.deleteEngineer}
                    onSetAvailability={(engineerId, availability) => {
                      void dash.updateEngineerAvailability(engineerId, availability);
                    }}
                  />
                ) : null}
                {stackViewKey(stackNav) === 'main' ? (
                  <>
                    <EngineerColumn
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
                      previousPlan={dash.previousPlan}
                      historyOpen={historyOpen}
                      historySelection={historySelection}
                      selectedEngineerId={dash.selectedEngineerId}
                      selectedRequestId={dash.selectedRequest?.id ?? null}
                      progressByEngineer={liveProgress}
                      completedByEngineer={liveCompleted}
                      handoffs={dash.liveWorkday?.handoffs ?? []}
                      frame={mapFrame}
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
                        <RequestDetails
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
                            if (dash.snapshot?.plan.mode !== 'manual') {
                              openManualPlanning('mode');
                              return;
                            }
                            await dash.assignRequest(openedRequestId, engineerId);
                          }
                    }
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </ManualPlanningProvider>
      </div>
    </div>
  );
}
