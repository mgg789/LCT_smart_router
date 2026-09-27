import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelDispatchRequest,
  changeEngineerEmail,
  closeDispatchShift,
  createDispatchEngineer,
  createDispatchRequest,
  DashboardApiError,
  deleteDispatchEngineer,
  ImportCancelledError,
  importOfficialDataset,
  importRoadData,
  linkEngineerAccount,
  loadDashboardSnapshot,
  loadPolicyComparison,
  loginDispatcher,
  markDispatchNoticeSeen,
  requestDispatcherLoginCode,
  resolveDispatchAlert,
  restartDemoStand,
  restorePreviousPlan,
  selectRoutingPolicy,
  setDispatchMode,
  setEngineerAttendanceOptOut,
  setEngineerAvailability,
  setOrdinaryReplanning,
  signOutDispatcher,
  simulateChange,
  simulationWorsens,
  unlinkEngineerAccount,
  updateDispatchEngineerProfile,
  updateRouterTechnicalSettings,
  uploadDataPackage,
  verifyDispatcherLoginCode,
} from '../api/client';
import { type DispatchLiveView, loadDispatchLive, startLiveWorkday } from '../api/live';
import { loadManualState, saveManualDecision } from '../api/manual';
import type {
  AlertResolutionInput,
  CreateDispatchEngineerInput,
  CreateDispatchRequestInput,
  DashboardSnapshot,
  DataUploadFile,
  DataUploadSummary,
  EngineerDayView,
  OfficialImportSummary,
  PlanDelta,
  PolicyComparisonResponse,
  PolicyId,
  ReviewImportQuality,
  RoadImportSummary,
  RouterTechnicalSettings,
} from '../api/types';
import { demoScenarios, recordedScenario } from '../demo/scenarios';
import {
  assignmentFor,
  computePlanDelta,
  type DashboardFocus,
  engineerSummaries,
  isExpectedRebuildApplied,
  type RebuildExpectation,
  reconcileDashboardFocus,
  requestById,
  routeForEngineer,
  unassignedRequests,
} from '../domain/dashboard';
import {
  type ConnectionDiagnostic,
  clearSavedDay,
  connectionDiagnostic,
  recoverySessionExpired,
  restoreDay,
  saveDay,
  startRecoverySession,
} from '../domain/resilience';

import { usePlanHistory } from './usePlanHistory';

const SESSION_KEY = 'lct.dispatcher.session';
/** A cold MKAD solve of the demo day has taken about four minutes. */
const DEFAULT_REBUILD_TIMEOUT_MS = 360_000;

export interface DayEvent {
  readonly id: string;
  readonly at: number;
  readonly text: string;
}

/** Owns authentication and the live Dashboard-to-backend state flow. */
function engineerNameMap(
  ...groups: Array<ReadonlyArray<{ id: string; displayName: string }> | undefined>
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const group of groups) {
    for (const engineer of group ?? []) names.set(engineer.id, engineer.displayName);
  }
  return names;
}

export function useDashboard() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(SESSION_KEY));
  const [recovered] = useState(() => restoreDay(sessionStorage, token !== null));
  const [source, setSourceState] = useState<'live' | 'cached' | 'demo'>(
    new URLSearchParams(window.location.search).get('demo') === '1'
      ? 'demo'
      : recovered
        ? 'cached'
        : 'live',
  );
  const sourceRef = useRef(source);
  const setSource = useCallback((next: 'live' | 'cached' | 'demo') => {
    sourceRef.current = next;
    setSourceState(next);
  }, []);
  const [snapshot, setSnapshotState] = useState<DashboardSnapshot | null>(
    source === 'demo' ? null : (recovered?.snapshot ?? null),
  );
  const snapshotRef = useRef(snapshot);
  const [savedAt, setSavedAt] = useState<number | null>(recovered?.savedAt ?? null);
  const [cacheAvailable, setCacheAvailable] = useState(recovered !== null);
  const [diagnostic, setDiagnostic] = useState<ConnectionDiagnostic | null>(null);
  const [operationWarning, setOperationWarning] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState('initial');
  const setSnapshot = useCallback(
    (next: DashboardSnapshot | null) => {
      snapshotRef.current = next;
      setSnapshotState(next);
      if (next && sourceRef.current !== 'demo') {
        setSource('live');
        setSavedAt(Date.now());
        setCacheAvailable(saveDay(sessionStorage, next));
      }
    },
    [setSource],
  );
  const [loading, setLoading] = useState(token !== null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<DashboardFocus>({ engineerId: null, requestId: null });
  const [savingReplanning, setSavingReplanning] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [availabilityPendingId, setAvailabilityPendingId] = useState<string | null>(null);
  const [uploadingData, setUploadingData] = useState(false);
  const [entityMutationPending, setEntityMutationPending] = useState(false);
  const [pendingDelta, setPendingDelta] = useState<PlanDelta | null>(null);
  const planHistory = usePlanHistory(
    token,
    snapshot?.plan.plan?.revision ?? null,
    source === 'live',
  );
  const [policyComparison, setPolicyComparison] = useState<PolicyComparisonResponse | null>(null);
  const [worseningText, setWorseningText] = useState<string | null>(null);
  const worseningResolve = useRef<((accepted: boolean) => void) | null>(null);
  const [policyComparisonLoading, setPolicyComparisonLoading] = useState(false);
  const [policyComparisonError, setPolicyComparisonError] = useState<string | null>(null);
  const [events, setEvents] = useState<DayEvent[]>([]);
  const [liveWorkday, setLiveWorkday] = useState<DispatchLiveView | null>(null);
  const [liveLoading, setLiveLoading] = useState(token !== null);
  const [startingWorkday, setStartingWorkday] = useState(false);
  const refreshInFlight = useRef(false);
  const liveRefreshInFlight = useRef(false);
  const comparisonInFlight = useRef(false);
  const readGeneration = useRef(0);
  const liveReadGeneration = useRef(0);
  const comparisonRequestId = useRef(0);

  const invalidateAsyncReads = useCallback(() => {
    readGeneration.current += 1;
    liveReadGeneration.current += 1;
    comparisonRequestId.current += 1;
    refreshInFlight.current = false;
    liveRefreshInFlight.current = false;
    comparisonInFlight.current = false;
    setPolicyComparison(null);
    setPolicyComparisonLoading(false);
    setPolicyComparisonError(null);
  }, []);

  const handleSessionFailure = useCallback(
    (reason: string) => {
      invalidateAsyncReads();
      sessionStorage.removeItem(SESSION_KEY);
      clearSavedDay(sessionStorage);
      setCacheAvailable(false);
      setSavedAt(null);
      setSource('live');
      setToken(null);
      setRebuilding(false);
      setUploadingData(false);
      setEntityMutationPending(false);
      setAvailabilityPendingId(null);
      setSnapshot(null);
      setFocus({ engineerId: null, requestId: null });
      setLoading(false);
      setLiveLoading(false);
      setStartingWorkday(false);
      setLiveWorkday(null);
      setError(reason);
    },
    [invalidateAsyncReads, setSnapshot, setSource],
  );

  const reportFailure = useCallback(
    (cause: unknown) => {
      setDiagnostic(connectionDiagnostic(cause));
      if (cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403)) {
        handleSessionFailure('Доступ к рабочим данным закрыт. Войдите снова.');
        return;
      }
      if (snapshotRef.current && sourceRef.current !== 'demo') setSource('cached');
    },
    [handleSessionFailure, setSource],
  );

  const refresh = useCallback(async () => {
    if (!token || sourceRef.current === 'demo' || refreshInFlight.current) {
      return null;
    }
    if (recoverySessionExpired(sessionStorage)) {
      handleSessionFailure('Сессия закончилась. Войдите снова.');
      return null;
    }
    const generation = readGeneration.current;
    refreshInFlight.current = true;
    try {
      const next = await loadDashboardSnapshot(token);
      if (generation !== readGeneration.current) {
        return null;
      }
      setSnapshot(next);
      setFocus((current) => reconcileDashboardFocus(next, current));
      setOperationWarning(null);
      setDiagnostic(null);
      setError(null);
      return next;
    } catch (cause) {
      if (generation !== readGeneration.current) {
        return null;
      }
      reportFailure(cause);
      if (cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403)) {
        handleSessionFailure('Сессия закончилась. Войдите снова.');
        return null;
      }
      setError(errorMessage(cause));
      return null;
    } finally {
      if (generation === readGeneration.current) {
        refreshInFlight.current = false;
        setLoading(false);
      }
    }
  }, [handleSessionFailure, token, reportFailure, setSnapshot]);

  /** Reads the authoritative workday clock and engineer event projection. */
  const refreshLive = useCallback(async () => {
    if (!token || sourceRef.current === 'demo' || liveRefreshInFlight.current) {
      return null;
    }
    const generation = liveReadGeneration.current;
    liveRefreshInFlight.current = true;
    try {
      const next = await loadDispatchLive(token);
      if (generation !== liveReadGeneration.current) return null;
      setLiveWorkday(next);
      return next;
    } catch (cause) {
      if (generation !== liveReadGeneration.current) return null;
      reportFailure(cause);
      if (cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403)) {
        handleSessionFailure('Сессия закончилась. Войдите снова.');
        return null;
      }
      setError(errorMessage(cause));
      return null;
    } finally {
      if (generation === liveReadGeneration.current) {
        liveRefreshInFlight.current = false;
        setLiveLoading(false);
      }
    }
  }, [handleSessionFailure, reportFailure, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshLive();
  }, [refreshLive]);

  useEffect(() => {
    if (!token || source === 'demo' || rebuilding || liveWorkday?.workday.status === 'running') {
      return;
    }
    const interval = window.setInterval(() => {
      void refresh();
      // A failed first LIVE read must not leave the clock dark for the whole session.
      void refreshLive();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [rebuilding, refresh, refreshLive, token, source, liveWorkday?.workday.status]);

  useEffect(() => {
    if (!token || source === 'demo' || rebuilding || liveWorkday?.workday.status !== 'running') {
      return;
    }
    // Clock and engineer progress only. The six-call day snapshot stays off this
    // interval: it used every browser connection, so icons and clicks waited.
    const interval = window.setInterval(() => {
      void refreshLive();
    }, 2_000);
    const snapshotInterval = window.setInterval(() => {
      void refresh();
    }, 20_000);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(snapshotInterval);
    };
  }, [liveWorkday?.workday.status, rebuilding, refresh, refreshLive, source, token]);

  const seenPlanRevision = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (source !== 'live' || liveWorkday?.workday.status !== 'running') return;
    const revision = liveWorkday.workday.planRevision;
    if (revision === undefined) return;
    const next = revision ?? null;
    if (seenPlanRevision.current === undefined) {
      seenPlanRevision.current = next;
      return;
    }
    if (seenPlanRevision.current === next) return;
    seenPlanRevision.current = next;
    void refresh();
  }, [liveWorkday?.workday.planRevision, liveWorkday?.workday.status, refresh, source]);

  const seenGeometry = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (source !== 'live' || liveWorkday?.workday.status !== 'running') return;
    const done = liveWorkday.workday.geometryDone;
    const total = liveWorkday.workday.geometryTotal;
    if (done === undefined || total === undefined) return;
    const key = `${done}/${total}`;
    if (seenGeometry.current === undefined) {
      seenGeometry.current = key;
      return;
    }
    if (seenGeometry.current === key) return;
    seenGeometry.current = key;
    void refresh();
  }, [
    liveWorkday?.workday.geometryDone,
    liveWorkday?.workday.geometryTotal,
    liveWorkday?.workday.status,
    refresh,
    source,
  ]);

  const engineers = useMemo(() => (snapshot ? engineerSummaries(snapshot) : []), [snapshot]);
  const unassigned = useMemo(() => (snapshot ? unassignedRequests(snapshot) : []), [snapshot]);
  const selectedEngineerId = focus.engineerId;
  const selectedRequestId = focus.requestId;
  const selectedRoute =
    snapshot && selectedEngineerId ? routeForEngineer(snapshot, selectedEngineerId) : null;
  const selectedRequest =
    snapshot && selectedRequestId ? requestById(snapshot, selectedRequestId) : null;
  const selectedAssignment =
    snapshot && selectedRequestId ? assignmentFor(snapshot, selectedRequestId) : null;
  const selectedEngineer =
    snapshot && selectedEngineerId
      ? (snapshot.engineers.find((item) => item.id === selectedEngineerId) ?? null)
      : null;
  const unassignedIndex = selectedRequestId
    ? unassigned.findIndex((item) => item.id === selectedRequestId)
    : -1;

  const pushEvent = useCallback((text: string) => {
    setEvents((previous) => [
      { id: crypto.randomUUID(), at: Math.floor(Date.now() / 1000), text },
      ...previous,
    ]);
  }, []);

  const acceptSession = useCallback(
    (session: Awaited<ReturnType<typeof loginDispatcher>>, generation: number) => {
      if (generation !== readGeneration.current) return;
      invalidateAsyncReads();
      sessionStorage.setItem(SESSION_KEY, session.token);
      startRecoverySession(sessionStorage, session.expiresAt);
      setSource('live');
      setSnapshot(null);
      setLiveWorkday(null);
      setLiveLoading(true);
      setToken(session.token);
    },
    [invalidateAsyncReads, setSnapshot, setSource],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const generation = readGeneration.current;
      setLoading(true);
      setError(null);
      try {
        acceptSession(await loginDispatcher(email, password), generation);
      } catch (cause) {
        // A wrong mailbox or password is a failed attempt, not an expired session.
        // The login card only paints an error when this promise rejects; swallowing
        // it left the form unchanged.
        if (generation === readGeneration.current) {
          setLoading(false);
          setError(errorMessage(cause));
        }
        throw cause;
      }
    },
    [acceptSession],
  );

  /** Adopts the dispatcher session returned by the Figma login card without
   * duplicating the hook's session, cache, and LIVE reset semantics. */
  const acceptLoginSession = useCallback(
    (session: { readonly token: string; readonly expiresAt: number }) => {
      acceptSession(
        { token: session.token, expiresAt: session.expiresAt, role: 'dispatcher' },
        readGeneration.current,
      );
    },
    [acceptSession],
  );

  const requestLoginCode = useCallback(
    async (email: string) => {
      const generation = readGeneration.current;
      setLoading(true);
      setError(null);
      try {
        const issued = await requestDispatcherLoginCode(email);
        if (generation !== readGeneration.current) return null;
        setLoading(false);
        return issued;
      } catch (cause) {
        if (generation !== readGeneration.current) return null;
        reportFailure(cause);
        setError(errorMessage(cause));
        setLoading(false);
        return null;
      }
    },
    [reportFailure],
  );

  const signInWithCode = useCallback(
    async (email: string, code: string) => {
      const generation = readGeneration.current;
      setLoading(true);
      setError(null);
      try {
        acceptSession(await verifyDispatcherLoginCode(email, code), generation);
      } catch (cause) {
        if (generation !== readGeneration.current) return;
        reportFailure(cause);
        setError(errorMessage(cause));
        setLoading(false);
      }
    },
    [acceptSession, reportFailure],
  );

  const signOut = useCallback(async () => {
    const remoteToken = sourceRef.current === 'demo' ? null : token;
    invalidateAsyncReads();
    sessionStorage.removeItem(SESSION_KEY);
    clearSavedDay(sessionStorage);
    setSource('live');
    setSavedAt(null);
    setCacheAvailable(false);
    setToken(null);
    setRebuilding(false);
    setUploadingData(false);
    setAvailabilityPendingId(null);
    setSnapshot(null);
    setFocus({ engineerId: null, requestId: null });
    setPendingDelta(null);
    setPolicyComparison(null);
    setPolicyComparisonError(null);
    setError(null);
    setOperationWarning(null);
    setLiveWorkday(null);
    setLiveLoading(false);
    setStartingWorkday(false);
    if (remoteToken) await signOutDispatcher(remoteToken).catch(() => undefined);
  }, [invalidateAsyncReads, token, setSnapshot, setSource]);

  const selectDemoScenario = useCallback(
    (id: string, policy: PolicyId = 'compact') => {
      if (rebuilding || uploadingData) return;
      const recorded = recordedScenario(id, policy);
      const previous = sourceRef.current === 'demo' ? snapshotRef.current?.plan.plan : null;
      invalidateAsyncReads();
      setSource('demo');
      setScenarioId(id);
      setSnapshot(recorded.snapshot);
      setLiveWorkday(null);
      setLiveLoading(false);
      setPolicyComparison(recorded.comparison);
      setLoading(false);
      setError(null);
      setPendingDelta(
        previous && recorded.snapshot.plan.plan && id !== 'initial'
          ? computePlanDelta(
              previous,
              recorded.snapshot.plan.plan,
              0,
              engineerNameMap(snapshotRef.current?.engineers, recorded.snapshot.engineers),
            )
          : null,
      );
      setFocus({ engineerId: null, requestId: null });
      pushEvent(
        `Демо: ${demoScenarios.find((item) => item.id === id)?.title}. Записанный результат Router.`,
      );
    },
    [invalidateAsyncReads, pushEvent, rebuilding, uploadingData, setSource, setSnapshot],
  );

  const leaveDemo = useCallback(() => {
    invalidateAsyncReads();
    const cached = restoreDay(sessionStorage, token !== null);
    setSource(cached ? 'cached' : 'live');
    snapshotRef.current = cached?.snapshot ?? null;
    setSnapshotState(cached?.snapshot ?? null);
    setPendingDelta(null);
    setFocus({ engineerId: null, requestId: null });
    setEvents([]);
    setLiveWorkday(null);
    setLiveLoading(token !== null);
    setLoading(token !== null);
    void refresh();
  }, [invalidateAsyncReads, refresh, setSource, token]);

  const initialDemoApplied = useRef(false);
  useEffect(() => {
    if (initialDemoApplied.current) return;
    initialDemoApplied.current = true;
    if (new URLSearchParams(window.location.search).get('demo') === '1') {
      selectDemoScenario('initial');
    }
    // Only an explicit initial URL chooses demo; later source changes belong to the presenter.
  }, [selectDemoScenario]);

  const clearFocus = useCallback(() => {
    setFocus({ engineerId: null, requestId: null });
  }, []);

  const selectEngineer = useCallback(
    (engineerId: string) => {
      if (!snapshot) {
        return;
      }
      if (selectedEngineerId === engineerId) {
        clearFocus();
        return;
      }
      setFocus({ engineerId, requestId: null });
    },
    [clearFocus, selectedEngineerId, snapshot],
  );

  const selectRequest = useCallback(
    (requestId: string) => {
      if (!snapshot) {
        return;
      }
      const owner = snapshot.plan.plan?.assignments.find((item) => item.requestId === requestId);
      setFocus({ engineerId: owner?.engineerId ?? null, requestId });
    },
    [snapshot],
  );

  const selectUnassignedOffset = useCallback(
    (offset: number) => {
      if (unassigned.length === 0) {
        return;
      }
      const current = unassignedIndex >= 0 ? unassignedIndex : 0;
      const next = (current + offset + unassigned.length) % unassigned.length;
      const request = unassigned[next];
      if (request) {
        setFocus({ engineerId: null, requestId: request.id });
      }
    },
    [unassigned, unassignedIndex],
  );

  const rebuild = useCallback(
    async (
      nextPolicy: PolicyId,
      nextSettings: RouterTechnicalSettings,
      reason: string,
      selectPolicy = false,
    ) => {
      if (
        !token ||
        sourceRef.current !== 'live' ||
        !snapshot ||
        rebuilding ||
        operationWarning !== null
      ) {
        return false;
      }
      const previous = snapshot;
      const solveStartedAtMs = performance.now();
      const previousResultId = previous.plan.appliedResult?.resultId ?? null;
      const previousRevision = previous.plan.plan?.revision ?? null;
      let expectedInputHash: string | null = null;
      let expectedContextVersion = previous.routerContextVersion;
      invalidateAsyncReads();
      const generation = readGeneration.current;
      setRebuilding(true);
      setPendingDelta(null);
      setError(null);
      pushEvent(`${reason}. Router пересчитывает план…`);
      try {
        if (previous.routerSettings && !sameRouterSettings(previous.routerSettings, nextSettings)) {
          const updated = await updateRouterTechnicalSettings(token, {
            ...nextSettings,
            routerContextVersion: expectedContextVersion,
          });
          expectedContextVersion = updated.routerContextVersion;
        }
        if (generation !== readGeneration.current) return false;
        if (nextPolicy !== previous.policyId || selectPolicy) {
          try {
            const preview =
              nextPolicy === 'personal'
                ? null
                : await simulateChange(token, { policyId: nextPolicy });
            if (preview && simulationWorsens(preview.delta)) {
              const accepted = await new Promise<boolean>((resolve) => {
                worseningResolve.current = resolve;
                setWorseningText(preview.text);
              });
              setWorseningText(null);
              worseningResolve.current = null;
              if (!accepted) return false;
            }
          } catch {
            // No stored answer: the dispatcher can still apply the policy.
          }
          expectedInputHash = await selectRoutingPolicy(token, nextPolicy);
        }
        if (generation !== readGeneration.current) return false;
        const next = await waitForRebuild(
          token,
          {
            previousRevision,
            previousResultId,
            policyId: nextPolicy,
            lunchesEnabled: nextSettings.lunchesEnabled,
            inputHash: expectedInputHash,
            routerContextVersion: expectedContextVersion,
          },
          rebuildTimeoutMs(nextPolicy),
        );
        if (generation !== readGeneration.current) return false;
        setSnapshot(next);
        setFocus((current) => reconcileDashboardFocus(next, current));
        setPolicyComparison(null);
        if (previous.plan.plan && next.plan.plan) {
          setPendingDelta(
            computePlanDelta(
              previous.plan.plan,
              next.plan.plan,
              Math.round(performance.now() - solveStartedAtMs),
              engineerNameMap(previous.engineers, next.engineers),
            ),
          );
        }
        pushEvent(`Применён план rev.${next.plan.plan?.revision ?? '—'} (${nextPolicy}).`);
        return true;
      } catch (cause) {
        if (generation !== readGeneration.current) return false;
        reportFailure(cause);
        setError(errorMessage(cause));
        setOperationWarning(
          'Результат изменения не подтверждён. Проверьте актуальный план перед повторным действием.',
        );
        pushEvent(`Перестроение не завершено: ${errorMessage(cause)}`);
        await refresh();
        return false;
      } finally {
        setRebuilding(false);
      }
    },
    [
      invalidateAsyncReads,
      pushEvent,
      rebuilding,
      refresh,
      snapshot,
      token,
      reportFailure,
      setSnapshot,
      operationWarning,
    ],
  );

  const applyRoutingSettings = useCallback(
    (policyId: PolicyId, nextSettings: RouterTechnicalSettings, selectPolicy = false) => {
      if (!snapshot) {
        return;
      }
      const current = snapshot.routerSettings ?? defaultRouterSettings(snapshot);
      const changes = [
        policyId !== snapshot.policyId ? `политика ${policyId}` : null,
        nextSettings.lunchesEnabled !== snapshot.lunchesEnabled
          ? nextSettings.lunchesEnabled
            ? 'обеды включены'
            : 'обеды выключены'
          : null,
        nextSettings.strictTimeWindows !== current.strictTimeWindows ||
        nextSettings.windowLatenessToleranceSec !== current.windowLatenessToleranceSec ||
        nextSettings.departureLatenessToleranceSec !== current.departureLatenessToleranceSec ||
        nextSettings.taskStartLatenessToleranceSec !== current.taskStartLatenessToleranceSec
          ? 'допуск опоздания обновлён'
          : null,
        nextSettings.accessBufferSec !== current.accessBufferSec ? 'буфер доступа обновлён' : null,
        nextSettings.earlyFinishReplanThresholdSec !== current.earlyFinishReplanThresholdSec
          ? 'порог раннего финиша обновлён'
          : null,
        nextSettings.taskOverrunToleranceSec !== current.taskOverrunToleranceSec
          ? 'допуск переработки обновлён'
          : null,
        nextSettings.trafficEnabled !== current.trafficEnabled ? 'режим пробок обновлён' : null,
        nextSettings.metroEnabled !== current.metroEnabled ? 'режим метро обновлён' : null,
        nextSettings.equipmentEnabled !== current.equipmentEnabled
          ? 'режим оборудования обновлён'
          : null,
      ].filter((item): item is string => item !== null);
      if (selectPolicy || changes.length > 0 || !sameRouterSettings(current, nextSettings)) {
        void rebuild(
          policyId,
          nextSettings,
          changes.join(', ') || 'технические настройки обновлены',
          selectPolicy,
        );
      }
    },
    [rebuild, snapshot],
  );

  const toggleOrdinaryReplanning = useCallback(async () => {
    if (!token || source !== 'live' || !snapshot || savingReplanning) return;
    setSavingReplanning(true);
    try {
      const result = await setOrdinaryReplanning(token, !snapshot.ordinaryReplanningDisabled);
      pushEvent(
        result.ordinaryReplanningDisabled
          ? 'Обычные новые заявки остаются в алертах без перестройки.'
          : 'Автоперестройка по обычным заявкам включена.',
      );
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingReplanning(false);
    }
  }, [token, source, snapshot, savingReplanning, pushEvent, refresh]);

  const acceptDelta = useCallback(() => {
    setPendingDelta(null);
    pushEvent('Изменения плана просмотрены.');
  }, [pushEvent]);

  /** Starts the day once; the following refresh is read-only confirmation. */
  const startWorkday = useCallback(async () => {
    if (!token || sourceRef.current !== 'live' || startingWorkday) return false;
    const generation = ++liveReadGeneration.current;
    liveRefreshInFlight.current = false;
    setStartingWorkday(true);
    setError(null);
    try {
      const next = await startLiveWorkday(token);
      if (generation !== liveReadGeneration.current) return false;
      setLiveWorkday(next);
      pushEvent('Рабочий день запущен. План и статусы инженеров обновляются в LIVE-режиме.');
      void refresh();
      return true;
    } catch (cause) {
      if (generation !== liveReadGeneration.current) return false;
      if (isStartTimeout(cause)) {
        const started = await waitForStartedDay(
          token,
          generation,
          liveReadGeneration,
          setLiveWorkday,
        );
        if (started) {
          pushEvent('Рабочий день запущен. План и статусы инженеров обновляются в LIVE-режиме.');
          void refresh();
          return true;
        }
      }
      reportFailure(cause);
      setError(errorMessage(cause));
      return false;
    } finally {
      if (generation === liveReadGeneration.current) setStartingWorkday(false);
    }
  }, [pushEvent, refresh, reportFailure, startingWorkday, token]);

  const rejectDelta = useCallback(async () => {
    if (
      !token ||
      sourceRef.current !== 'live' ||
      !planHistory?.eligibility.eligible ||
      !planHistory.current
    )
      return false;
    setEntityMutationPending(true);
    try {
      const restored = await restorePreviousPlan(token, planHistory.current.revision);
      setPendingDelta(null);
      pushEvent(
        `Восстановлен план ревизии ${restored.fromRevision} новой ревизией ${restored.restoredRevision}.`,
      );
      await refresh();
      return true;
    } catch (cause) {
      reportFailure(cause);
      setError(errorMessage(cause));
      return false;
    } finally {
      setEntityMutationPending(false);
    }
  }, [token, planHistory, refresh, pushEvent, reportFailure]);

  const setMode = useCallback(
    async (mode: 'auto' | 'manual', reason?: string) => {
      if (!token || sourceRef.current !== 'live') {
        return;
      }
      invalidateAsyncReads();
      const generation = readGeneration.current;
      setError(null);
      try {
        await setDispatchMode(token, mode, reason);
        if (generation !== readGeneration.current) return;
        await refresh();
        pushEvent(
          mode === 'manual' ? 'Включён ручной режим.' : 'Восстановлен автоматический режим.',
        );
      } catch (cause) {
        if (generation !== readGeneration.current) return;
        reportFailure(cause);
        setOperationWarning(
          'Результат изменения режима не подтверждён. Проверьте состояние на сервере.',
        );
        setError(errorMessage(cause));
      }
    },
    [invalidateAsyncReads, pushEvent, refresh, token, reportFailure],
  );

  const refreshPolicyComparison = useCallback(async () => {
    if (sourceRef.current === 'demo') {
      setPolicyComparison(recordedScenario(scenarioId, snapshotRef.current?.policyId).comparison);
      return;
    }
    if (!token || sourceRef.current !== 'live' || rebuilding || comparisonInFlight.current) {
      return;
    }
    const generation = readGeneration.current;
    const requestId = ++comparisonRequestId.current;
    comparisonInFlight.current = true;
    setPolicyComparisonLoading(true);
    setPolicyComparisonError(null);
    try {
      const next = await loadPolicyComparison(token);
      if (generation !== readGeneration.current || requestId !== comparisonRequestId.current) {
        return;
      }
      setPolicyComparison(next);
    } catch (cause) {
      if (generation !== readGeneration.current || requestId !== comparisonRequestId.current) {
        return;
      }
      reportFailure(cause);
      if (cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403)) {
        handleSessionFailure('Сессия закончилась. Войдите снова.');
        return;
      }
      setPolicyComparisonError(errorMessage(cause));
    } finally {
      if (requestId === comparisonRequestId.current) {
        comparisonInFlight.current = false;
        setPolicyComparisonLoading(false);
      }
    }
  }, [handleSessionFailure, rebuilding, token, scenarioId, reportFailure]);

  const comparedRevision = useRef<number | null>(null);
  useEffect(() => {
    if (!token || source !== 'live' || rebuilding) return;
    const revision = snapshot?.plan.plan?.revision ?? null;
    if (revision === null || comparedRevision.current === revision) return;
    // The plan is already on screen. Comparison can fill in behind it.
    const handle = window.setTimeout(() => {
      comparedRevision.current = revision;
      void refreshPolicyComparison();
    }, 800);
    return () => window.clearTimeout(handle);
  }, [rebuilding, refreshPolicyComparison, snapshot?.plan.plan?.revision, source, token]);

  const updateEngineerAvailability = useCallback(
    async (engineerId: string, availability: 'online' | 'offline') => {
      if (
        !token ||
        sourceRef.current !== 'live' ||
        !snapshot ||
        rebuilding ||
        operationWarning !== null
      ) {
        return;
      }
      const previous = snapshot;
      const previousResultId = previous.plan.appliedResult?.resultId ?? null;
      const previousRevision = previous.plan.plan?.revision ?? null;
      const solveStartedAtMs = performance.now();
      invalidateAsyncReads();
      const generation = readGeneration.current;
      setAvailabilityPendingId(engineerId);
      setRebuilding(true);
      setPendingDelta(null);
      setError(null);
      pushEvent(
        availability === 'offline'
          ? `Отключаем ${engineerName(previous, engineerId)} от линии…`
          : `Возвращаем ${engineerName(previous, engineerId)} на линию…`,
      );
      try {
        const inputHash = await setEngineerAvailability(token, engineerId, availability);
        if (generation !== readGeneration.current) return false;
        const next = await waitForRebuild(
          token,
          {
            previousRevision,
            previousResultId,
            policyId: previous.policyId,
            lunchesEnabled: previous.lunchesEnabled,
            inputHash,
            routerContextVersion: previous.routerContextVersion,
          },
          rebuildTimeoutMs(previous.policyId),
        );
        if (generation !== readGeneration.current) return false;
        setSnapshot(next);
        setFocus((current) => reconcileDashboardFocus(next, current));
        setPolicyComparison(null);
        if (previous.plan.plan && next.plan.plan) {
          setPendingDelta(
            computePlanDelta(
              previous.plan.plan,
              next.plan.plan,
              Math.round(performance.now() - solveStartedAtMs),
              engineerNameMap(previous.engineers, next.engineers),
            ),
          );
        }
        pushEvent(
          `${engineerName(next, engineerId)}: ${availability === 'online' ? 'на линии' : 'отключён'}, применён план rev.${next.plan.plan?.revision ?? '—'}.`,
        );
      } catch (cause) {
        if (generation !== readGeneration.current) return;
        reportFailure(cause);
        setError(errorMessage(cause));
        pushEvent(
          `Не удалось подтвердить перестроение после смены статуса: ${errorMessage(cause)}`,
        );
        setOperationWarning('Результат изменения не подтверждён. Проверьте состояние на сервере.');
        await refresh();
      } finally {
        setAvailabilityPendingId(null);
        setRebuilding(false);
      }
    },
    [
      invalidateAsyncReads,
      pushEvent,
      rebuilding,
      refresh,
      snapshot,
      token,
      reportFailure,
      setSnapshot,
      operationWarning,
    ],
  );

  /** Grants or replaces an Engineer App login without changing routing parameters. */
  const saveEngineerLogin = useCallback(
    async (engineerId: string, email: string) => {
      if (!token || sourceRef.current !== 'live') {
        throw new Error('Изменение почты доступно только в живом контуре');
      }
      const engineer = snapshotRef.current?.engineers.find((item) => item.id === engineerId);
      if (engineer?.hasAccount) {
        await changeEngineerEmail(token, engineerId, email, engineer.version);
      } else {
        await linkEngineerAccount(token, engineerId, email);
      }
      await refresh();
    },
    [refresh, token],
  );

  /** Takes the login away so the Engineer App can no longer verify that address. */
  const unlinkEngineerLogin = useCallback(
    async (engineerId: string) => {
      if (!token || sourceRef.current !== 'live') {
        throw new Error('Снятие почты доступно только в живом контуре');
      }
      await unlinkEngineerAccount(token, engineerId);
      await refresh();
    },
    [refresh, token],
  );

  /** Runs one create/archive mutation and then reloads both dashboard projections. */
  const performEntityMutation = useCallback(
    async (operation: (session: string) => Promise<void>, eventText: string) => {
      if (
        !token ||
        sourceRef.current !== 'live' ||
        loading ||
        entityMutationPending ||
        operationWarning !== null
      ) {
        throw new Error('Изменение доступно только при подключении к рабочему серверу');
      }
      invalidateAsyncReads();
      setEntityMutationPending(true);
      setError(null);
      try {
        await operation(token);
        const [next] = await Promise.all([refresh(), refreshLive()]);
        if (!next) {
          setOperationWarning(
            'Изменение принято сервером, но обновление экрана не подтверждено. Не повторяйте операцию вслепую.',
          );
        }
        pushEvent(eventText);
      } catch (cause) {
        const uncertain = !(cause instanceof DashboardApiError) || cause.status === 0;
        if (
          uncertain ||
          (cause instanceof DashboardApiError && (cause.status === 401 || cause.status === 403))
        ) {
          reportFailure(cause);
        }
        if (uncertain) {
          setOperationWarning(
            'Результат изменения не подтверждён. Проверьте актуальный список перед повтором.',
          );
        }
        setError(errorMessage(cause));
        throw cause;
      } finally {
        setEntityMutationPending(false);
      }
    },
    [
      entityMutationPending,
      invalidateAsyncReads,
      loading,
      operationWarning,
      pushEvent,
      refresh,
      refreshLive,
      reportFailure,
      token,
    ],
  );

  const updateEngineerProfile = useCallback(
    (
      engineerId: string,
      patch: { region?: string; transportType?: 'car' | 'walk' | 'bike' | 'transit' },
    ) =>
      performEntityMutation(async (session) => {
        const engineer = snapshotRef.current?.engineers.find((item) => item.id === engineerId);
        if (!engineer) throw new Error('Инженер не найден. Обновите список.');
        await updateDispatchEngineerProfile(session, engineerId, engineer.version, patch);
      }, 'Профиль инженера обновлён.'),
    [performEntityMutation],
  );

  const createRequest = useCallback(
    (input: CreateDispatchRequestInput) =>
      performEntityMutation(async (session) => {
        await createDispatchRequest(session, input);
      }, 'Создана новая заявка.'),
    [performEntityMutation],
  );

  const cancelRequest = useCallback(
    (requestId: string) => {
      const current = snapshotRef.current?.requests.find((item) => item.id === requestId);
      return performEntityMutation(async (session) => {
        await cancelDispatchRequest(
          session,
          requestId,
          current?.version,
          'cancelled by dispatcher',
        );
      }, 'Визит отменён.');
    },
    [performEntityMutation],
  );

  const assignRequest = useCallback(
    (requestId: string, engineerId: string) => {
      const engineer = snapshotRef.current?.engineers.find((item) => item.id === engineerId);
      return performEntityMutation(
        async (session) => {
          const manual = await loadManualState(session);
          await saveManualDecision(session, manual.version, {
            kind: 'assignment',
            targetId: requestId,
            engineerId,
          });
        },
        `Заявка назначена инженеру ${engineer?.displayName ?? engineerId}.`,
      );
    },
    [performEntityMutation],
  );

  const createEngineer = useCallback(
    (input: CreateDispatchEngineerInput) =>
      performEntityMutation(async (session) => {
        await createDispatchEngineer(session, input);
      }, `Добавлен инженер ${input.displayName}.`),
    [performEntityMutation],
  );

  const deleteEngineer = useCallback(
    (engineerId: string) => {
      const engineer = snapshotRef.current?.engineers.find((item) => item.id === engineerId);
      return performEntityMutation(
        async (session) => {
          await deleteDispatchEngineer(session, engineerId, engineer?.version);
        },
        `Инженер ${engineer?.displayName ?? engineerId} удалён из активного состава.`,
      );
    },
    [performEntityMutation],
  );

  const performAlertOperation = useCallback(
    async (operation: (session: string) => Promise<void>, onSuccess?: () => void) => {
      if (!token || sourceRef.current !== 'live' || loading || operationWarning !== null) {
        throw new Error('Для решения алертов нужно подключение к рабочему серверу');
      }
      const generation = readGeneration.current;
      try {
        await operation(token);
        onSuccess?.();
      } catch (cause) {
        if (
          generation === readGeneration.current &&
          cause instanceof DashboardApiError &&
          (cause.status === 401 || cause.status === 403)
        )
          reportFailure(cause);
        throw cause;
      }
      if (generation === readGeneration.current) await refresh();
    },
    [loading, operationWarning, refresh, reportFailure, token],
  );

  const resolveAlert = useCallback(
    (id: string, input: AlertResolutionInput) =>
      performAlertOperation(
        (session) => resolveDispatchAlert(session, id, input),
        input.action === 'move_window' ||
          input.action === 'restore_auto' ||
          input.action === 'prioritize'
          ? undefined
          : () => {
              const current = snapshotRef.current;
              if (!current) return;
              setSnapshot({
                ...current,
                alerts: current.alerts.filter((alert) => alert.id !== id),
              });
            },
      ),
    [performAlertOperation, setSnapshot],
  );

  const setAttendanceOptOut = useCallback(
    (day: EngineerDayView, optOut: boolean) =>
      performAlertOperation((session) => setEngineerAttendanceOptOut(session, day, optOut)),
    [performAlertOperation],
  );

  const markNoticeSeen = useCallback(
    (id: string) => performAlertOperation((session) => markDispatchNoticeSeen(session, id)),
    [performAlertOperation],
  );

  const closeShift = useCallback(
    (workDate: string, operationId: string) =>
      performAlertOperation((session) => closeDispatchShift(session, workDate, operationId)),
    [performAlertOperation],
  );

  const restartDemoDay = useCallback(async () => {
    if (!token) throw new Error('Нужна живая сессия диспетчера');
    invalidateAsyncReads();
    const generation = readGeneration.current;
    const summary = await restartDemoStand(token);
    if (generation !== readGeneration.current) return summary;
    await Promise.all([refresh(), refreshLive()]);
    return summary;
  }, [invalidateAsyncReads, refresh, refreshLive, token]);

  const uploadDataset = useCallback(
    async (file: DataUploadFile, review?: ReviewImportQuality): Promise<DataUploadSummary> => {
      if (!token || sourceRef.current !== 'live' || uploadingData) {
        throw new Error('Загрузка данных уже выполняется');
      }
      invalidateAsyncReads();
      const generation = readGeneration.current;
      setUploadingData(true);
      setError(null);
      try {
        const summary = await uploadDataPackage(token, file, review);
        if (generation !== readGeneration.current) return summary;
        try {
          const next = await loadDashboardSnapshot(token);
          if (generation !== readGeneration.current) return summary;
          setSnapshot(next);
        } catch (refreshCause) {
          if (generation !== readGeneration.current) return summary;
          reportFailure(refreshCause);
          setOperationWarning(
            'Данные приняты сервером, но обновление экрана не подтверждено. Не отправляйте пакет повторно.',
          );
          setError(`Данные приняты, но экран не обновился: ${errorMessage(refreshCause)}`);
        }
        setFocus({ engineerId: null, requestId: null });
        setPolicyComparison(null);
        await refreshLive();
        pushEvent(
          summary.applied
            ? `Регион ${summary.region}: добавлено ${summary.requestsCreated} заявок.`
            : `Пакет региона ${summary.region} уже был загружен.`,
        );
        return summary;
      } catch (cause) {
        if (cause instanceof ImportCancelledError) throw cause;
        if (generation === readGeneration.current) {
          reportFailure(cause);
          setOperationWarning(
            'Результат загрузки не подтверждён. Проверьте список заявок перед повтором.',
          );
          setError(errorMessage(cause));
        }
        throw cause;
      } finally {
        setUploadingData(false);
      }
    },
    [
      invalidateAsyncReads,
      pushEvent,
      refreshLive,
      token,
      uploadingData,
      reportFailure,
      setSnapshot,
    ],
  );

  const importRoadResource = useCallback(
    async (payloadBase64: string): Promise<RoadImportSummary> => {
      if (!token || sourceRef.current !== 'live' || uploadingData) {
        throw new Error('Загрузка данных уже выполняется');
      }
      invalidateAsyncReads();
      const generation = readGeneration.current;
      setUploadingData(true);
      setError(null);
      try {
        const summary = await importRoadData(token, payloadBase64);
        if (generation !== readGeneration.current) return summary;
        await refreshLive();
        pushEvent(
          summary.status === 'replayed'
            ? 'Дорожный ресурс уже был импортирован.'
            : `Дорожный ресурс принят: ${summary.edges} рёбер, ${summary.nodes} узлов.`,
        );
        return summary;
      } catch (cause) {
        if (generation === readGeneration.current) {
          reportFailure(cause);
          setOperationWarning(
            'Импорт дорожного ресурса не подтверждён. Проверьте журнал операций.',
          );
          setError(errorMessage(cause));
        }
        throw cause;
      } finally {
        setUploadingData(false);
      }
    },
    [invalidateAsyncReads, pushEvent, refreshLive, reportFailure, token, uploadingData],
  );

  const importOfficialTzDataset = useCallback(
    async (review?: ReviewImportQuality): Promise<OfficialImportSummary> => {
      if (!token || sourceRef.current !== 'live' || uploadingData) {
        throw new Error('Загрузка данных уже выполняется');
      }
      invalidateAsyncReads();
      const generation = readGeneration.current;
      setUploadingData(true);
      setError(null);
      try {
        const summary = await importOfficialDataset(token, review);
        if (generation !== readGeneration.current) return summary;
        try {
          const next = await loadDashboardSnapshot(token);
          if (generation !== readGeneration.current) return summary;
          setSnapshot(next);
        } catch (refreshCause) {
          if (generation !== readGeneration.current) return summary;
          reportFailure(refreshCause);
          setOperationWarning(
            'Датасет принят сервером, но обновление экрана не подтверждено. Не запускайте импорт повторно.',
          );
          setError(`Датасет принят, но экран не обновился: ${errorMessage(refreshCause)}`);
        }
        setFocus({ engineerId: null, requestId: null });
        setPolicyComparison(null);
        await refreshLive();
        pushEvent(
          summary.applied
            ? `Датасет из ТЗ: ${summary.requestsCreated} заявок, ${summary.engineersCreated} инженеров.`
            : 'Официальный датасет из ТЗ уже был загружен.',
        );
        return summary;
      } catch (cause) {
        if (cause instanceof ImportCancelledError) throw cause;
        if (generation === readGeneration.current) {
          reportFailure(cause);
          setOperationWarning('Импорт датасета из ТЗ не подтверждён. Проверьте список заявок.');
          setError(errorMessage(cause));
        }
        throw cause;
      } finally {
        setUploadingData(false);
      }
    },
    [
      invalidateAsyncReads,
      pushEvent,
      refreshLive,
      token,
      uploadingData,
      reportFailure,
      setSnapshot,
    ],
  );

  const displaySnapshot = useMemo(
    () =>
      snapshot && liveWorkday?.workday.status === 'running'
        ? { ...snapshot, nowAt: liveWorkday.workday.liveNow }
        : snapshot,
    [liveWorkday, snapshot],
  );

  return {
    authenticated: token !== null || source === 'demo',
    source,
    savedAt,
    cacheAvailable,
    diagnostic,
    scenarioId,
    operationWarning,
    /** Live session credential; null in the demo and cached contours. Screens that call
     * the live API directly (token management) read it rather than guessing the source. */
    token,
    worseningText,
    answerWorsening: (accepted: boolean) => {
      setWorseningText(null);
      worseningResolve.current?.(accepted);
      worseningResolve.current = null;
    },
    dismissOperationWarning: () => setOperationWarning(null),
    selectDemoScenario,
    leaveDemo,
    demoScenarios,
    writesDisabled:
      source !== 'live' || loading || entityMutationPending || operationWarning !== null,
    busy: rebuilding || uploadingData || entityMutationPending,
    isDemo: source === 'demo',
    loading,
    error,
    snapshot: displaySnapshot,
    liveWorkday,
    liveLoading,
    startingWorkday,
    engineers,
    unassigned,
    selectedEngineerId,
    selectedEngineer,
    selectedRoute,
    selectedRequest,
    selectedAssignment,
    unassignedIndex,
    rebuilding,
    availabilityPendingId,
    uploadingData,
    entityMutationPending,
    pendingDelta,
    canRejectDelta: planHistory?.eligibility.eligible === true,
    previousPlan: planHistory?.previous ?? null,
    restoreUnavailableReason: planHistory?.eligibility.reason ?? null,
    policyComparison,
    policyComparisonLoading,
    policyComparisonError,
    events,
    acceptLoginSession,
    signIn,
    requestLoginCode,
    signInWithCode,
    signOut,
    refresh,
    refreshLive,
    startWorkday,
    selectEngineer,
    clearFocus,
    selectRequest,
    selectUnassignedOffset,
    applyRoutingSettings,
    toggleOrdinaryReplanning,
    savingReplanning,
    acceptDelta,
    rejectDelta,
    setMode,
    refreshPolicyComparison,
    updateEngineerAvailability,
    saveEngineerLogin,
    updateEngineerProfile,
    unlinkEngineerLogin,
    createRequest,
    cancelRequest,
    assignRequest,
    createEngineer,
    deleteEngineer,
    uploadDataset,
    importRoadResource,
    importOfficialTzDataset,
    resolveAlert,
    setAttendanceOptOut,
    markNoticeSeen,
    closeShift,
    restartDemoDay,
  };
}

/** Covering leftover is FIFO on idle crews; one compact solve must finish in this window. */
function rebuildTimeoutMs(_policyId: PolicyId): number {
  return DEFAULT_REBUILD_TIMEOUT_MS;
}

/** Compares persisted routing controls while ignoring the context revision itself. */
function sameRouterSettings(
  left: RouterTechnicalSettings,
  right: RouterTechnicalSettings,
): boolean {
  return (
    left.lunchesEnabled === right.lunchesEnabled &&
    left.departureLatenessToleranceSec === right.departureLatenessToleranceSec &&
    left.taskStartLatenessToleranceSec === right.taskStartLatenessToleranceSec &&
    (left.strictTimeWindows ?? false) === (right.strictTimeWindows ?? false) &&
    left.windowLatenessToleranceSec === right.windowLatenessToleranceSec &&
    left.trafficEnabled === right.trafficEnabled &&
    left.metroEnabled === right.metroEnabled &&
    left.equipmentEnabled === right.equipmentEnabled &&
    left.equipmentTransfersEnabled === right.equipmentTransfersEnabled &&
    left.travelTimeMode === right.travelTimeMode &&
    left.accessBufferSec === right.accessBufferSec &&
    left.fixedTravelTimeSec === right.fixedTravelTimeSec &&
    left.earlyFinishReplanThresholdSec === right.earlyFinishReplanThresholdSec &&
    left.taskOverrunToleranceSec === right.taskOverrunToleranceSec
  );
}

/** Supplies compatibility defaults for cached snapshots created before settings were exposed. */
function defaultRouterSettings(snapshot: DashboardSnapshot): RouterTechnicalSettings {
  return {
    lunchesEnabled: snapshot.lunchesEnabled,
    metroEnabled: false,
    departureLatenessToleranceSec: 0,
    taskStartLatenessToleranceSec: 0,
    windowLatenessToleranceSec: 0,
    trafficEnabled: true,
    equipmentEnabled: true,
    equipmentTransfersEnabled: false,
    travelTimeMode: 'graph_with_access_buffer',
    accessBufferSec: 600,
    fixedTravelTimeSec: 1_200,
    earlyFinishReplanThresholdSec: 900,
    taskOverrunToleranceSec: 600,
    routerContextVersion: snapshot.routerContextVersion,
  };
}

async function waitForRebuild(
  token: string,
  expected: RebuildExpectation,
  timeoutMs: number,
): Promise<DashboardSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await loadDashboardSnapshot(token);
    if (isExpectedRebuildApplied(snapshot, expected)) {
      return snapshot;
    }
    await delay(750);
  }
  throw new Error(
    `Router не успел применить новую ревизию за ${Math.round(timeoutMs / 1000)} секунд`,
  );
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function isStartTimeout(cause: unknown): boolean {
  return cause instanceof DashboardApiError && /не ответил|нет связи/i.test(cause.message);
}

/** The start call can outlive the first response. Keep the button on «Запускаем». */
async function waitForStartedDay(
  token: string,
  generation: number,
  liveReadGeneration: { readonly current: number },
  setLiveWorkday: (value: DispatchLiveView) => void,
): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await delay(1_000);
    if (generation !== liveReadGeneration.current) return false;
    try {
      const next = await loadDispatchLive(token);
      if (generation !== liveReadGeneration.current) return false;
      if (next.workday.status === 'running' || next.workday.status === 'finished') {
        setLiveWorkday(next);
        return true;
      }
    } catch {
      // The original start is still the request the screen is waiting on.
    }
  }
  return false;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Не удалось выполнить запрос';
}

function engineerName(snapshot: DashboardSnapshot, engineerId: string): string {
  return snapshot.engineers.find((item) => item.id === engineerId)?.displayName ?? engineerId;
}
