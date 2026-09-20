import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  closeDispatchShift,
  DashboardApiError,
  importOfficialDataset,
  linkEngineerAccount,
  loadDashboardSnapshot,
  loadPolicyComparison,
  loginDispatcher,
  markDispatchNoticeSeen,
  requestDispatcherLoginCode,
  resolveDispatchAlert,
  selectRoutingPolicy,
  setDispatchMode,
  setEngineerAttendanceOptOut,
  setEngineerAvailability,
  signOutDispatcher,
  unlinkEngineerAccount,
  updateRouterTechnicalSettings,
  uploadDataPackage,
  verifyDispatcherLoginCode,
} from '../api/client';
import type {
  AlertResolutionInput,
  DashboardSnapshot,
  DataUploadFile,
  DataUploadSummary,
  EngineerDayView,
  OfficialImportSummary,
  PlanDelta,
  PolicyComparisonResponse,
  PolicyId,
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

const SESSION_KEY = 'lct.dispatcher.session';
const DEFAULT_REBUILD_TIMEOUT_MS = 90_000;

export interface DayEvent {
  readonly id: string;
  readonly at: number;
  readonly text: string;
}

interface RoutingBaseline {
  readonly snapshot: DashboardSnapshot;
  readonly policyId: PolicyId;
  readonly lunchesEnabled: boolean;
  readonly routerSettings: RouterTechnicalSettings | null;
}

/** Owns authentication and the live Dashboard-to-backend state flow. */
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
  const [rebuilding, setRebuilding] = useState(false);
  const [availabilityPendingId, setAvailabilityPendingId] = useState<string | null>(null);
  const [uploadingData, setUploadingData] = useState(false);
  const [pendingDelta, setPendingDelta] = useState<PlanDelta | null>(null);
  const [baseline, setBaseline] = useState<RoutingBaseline | null>(null);
  const [policyComparison, setPolicyComparison] = useState<PolicyComparisonResponse | null>(null);
  const [policyComparisonLoading, setPolicyComparisonLoading] = useState(false);
  const [policyComparisonError, setPolicyComparisonError] = useState<string | null>(null);
  const [events, setEvents] = useState<DayEvent[]>([]);
  const refreshInFlight = useRef(false);
  const comparisonInFlight = useRef(false);
  const readGeneration = useRef(0);
  const comparisonRequestId = useRef(0);

  const invalidateAsyncReads = useCallback(() => {
    readGeneration.current += 1;
    comparisonRequestId.current += 1;
    refreshInFlight.current = false;
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
      setAvailabilityPendingId(null);
      setSnapshot(null);
      setFocus({ engineerId: null, requestId: null });
      setLoading(false);
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!token || source === 'demo' || rebuilding) {
      return;
    }
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [rebuilding, refresh, token, source]);

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
        if (generation !== readGeneration.current) return;
        reportFailure(cause);
        setError(errorMessage(cause));
        setLoading(false);
      }
    },
    [acceptSession, reportFailure],
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
    setBaseline(null);
    setPolicyComparison(null);
    setPolicyComparisonError(null);
    setError(null);
    setOperationWarning(null);
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
      setPolicyComparison(recorded.comparison);
      setLoading(false);
      setError(null);
      setPendingDelta(
        previous && recorded.snapshot.plan.plan && id !== 'initial'
          ? computePlanDelta(previous, recorded.snapshot.plan.plan, 0)
          : null,
      );
      setBaseline(null);
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
    setBaseline(null);
    setFocus({ engineerId: null, requestId: null });
    setEvents([]);
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
      keepBaseline: boolean,
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
      if (keepBaseline) {
        setBaseline({
          snapshot: previous,
          policyId: previous.policyId,
          lunchesEnabled: previous.lunchesEnabled,
          routerSettings: previous.routerSettings ?? null,
        });
      }
      try {
        if (previous.plan.mode === 'manual') {
          await setDispatchMode(token, 'auto');
          pushEvent('Для перестроения включён авторежим — иначе Router не применит новый план.');
        }
        if (previous.routerSettings && !sameRouterSettings(previous.routerSettings, nextSettings)) {
          const updated = await updateRouterTechnicalSettings(token, {
            ...nextSettings,
            routerContextVersion: expectedContextVersion,
          });
          expectedContextVersion = updated.routerContextVersion;
        }
        if (generation !== readGeneration.current) return false;
        if (nextPolicy !== previous.policyId) {
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
    (policyId: PolicyId, nextSettings: RouterTechnicalSettings) => {
      if (!snapshot) {
        return;
      }
      const changes = [
        policyId !== snapshot.policyId ? `политика ${policyId}` : null,
        nextSettings.lunchesEnabled !== snapshot.lunchesEnabled
          ? nextSettings.lunchesEnabled
            ? 'обеды включены'
            : 'обеды выключены'
          : null,
        snapshot.routerSettings &&
        nextSettings.windowLatenessToleranceSec !==
          snapshot.routerSettings.windowLatenessToleranceSec
          ? 'допуск окна обновлён'
          : null,
        snapshot.routerSettings &&
        nextSettings.accessBufferSec !== snapshot.routerSettings.accessBufferSec
          ? 'буфер доступа обновлён'
          : null,
        snapshot.routerSettings &&
        nextSettings.trafficEnabled !== snapshot.routerSettings.trafficEnabled
          ? 'режим пробок обновлён'
          : null,
        snapshot.routerSettings &&
        nextSettings.equipmentEnabled !== snapshot.routerSettings.equipmentEnabled
          ? 'режим оборудования обновлён'
          : null,
      ].filter((item): item is string => item !== null);
      if (changes.length > 0) {
        void rebuild(policyId, nextSettings, changes.join(', '), true);
      }
    },
    [rebuild, snapshot],
  );

  const acceptDelta = useCallback(() => {
    setPendingDelta(null);
    setBaseline(null);
    pushEvent('Изменения плана просмотрены.');
  }, [pushEvent]);

  const rejectDelta = useCallback(() => {
    if (!baseline) {
      return;
    }
    const previousDelta = pendingDelta;
    setPendingDelta(null);
    void rebuild(
      baseline.policyId,
      baseline.routerSettings ?? defaultRouterSettings(baseline.snapshot),
      'возвращаем прежние настройки',
      false,
    ).then((restored) => {
      if (restored) {
        setBaseline(null);
      } else {
        setPendingDelta(previousDelta);
      }
    });
  }, [baseline, pendingDelta, rebuild]);

  const setMode = useCallback(
    async (mode: 'auto' | 'manual') => {
      if (!token || sourceRef.current !== 'live') {
        return;
      }
      invalidateAsyncReads();
      const generation = readGeneration.current;
      setError(null);
      try {
        await setDispatchMode(token, mode);
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
      setBaseline(null);
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

  /** Grants a login address to a brigade that arrived without one. Does not republish. */
  const linkEngineerLogin = useCallback(
    async (engineerId: string, email: string) => {
      if (!token || sourceRef.current !== 'live') {
        throw new Error('Привязка почты доступна только в живом контуре');
      }
      await linkEngineerAccount(token, engineerId, email);
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

  const performAlertOperation = useCallback(
    async (operation: (session: string) => Promise<void>) => {
      if (!token || sourceRef.current !== 'live' || loading || operationWarning !== null) {
        throw new Error('Для решения алертов нужно подключение к рабочему серверу');
      }
      const generation = readGeneration.current;
      try {
        await operation(token);
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
      performAlertOperation((session) => resolveDispatchAlert(session, id, input)),
    [performAlertOperation],
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

  const uploadDataset = useCallback(
    async (file: DataUploadFile): Promise<DataUploadSummary> => {
      if (!token || sourceRef.current !== 'live' || uploadingData) {
        throw new Error('Загрузка данных уже выполняется');
      }
      invalidateAsyncReads();
      const generation = readGeneration.current;
      setUploadingData(true);
      setError(null);
      try {
        const summary = await uploadDataPackage(token, file);
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
        pushEvent(
          summary.applied
            ? `Регион ${summary.region}: добавлено ${summary.requestsCreated} заявок.`
            : `Пакет региона ${summary.region} уже был загружен.`,
        );
        return summary;
      } catch (cause) {
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
    [invalidateAsyncReads, pushEvent, token, uploadingData, reportFailure, setSnapshot],
  );

  const importOfficialTzDataset = useCallback(async (): Promise<OfficialImportSummary> => {
    if (!token || sourceRef.current !== 'live' || uploadingData) {
      throw new Error('Загрузка данных уже выполняется');
    }
    invalidateAsyncReads();
    const generation = readGeneration.current;
    setUploadingData(true);
    setError(null);
    try {
      const summary = await importOfficialDataset(token);
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
      pushEvent(
        summary.applied
          ? `Датасет из ТЗ: ${summary.requestsCreated} заявок, ${summary.engineersCreated} инженеров.`
          : 'Официальный датасет из ТЗ уже был загружен.',
      );
      return summary;
    } catch (cause) {
      if (generation === readGeneration.current) {
        reportFailure(cause);
        setOperationWarning('Импорт датасета из ТЗ не подтверждён. Проверьте список заявок.');
        setError(errorMessage(cause));
      }
      throw cause;
    } finally {
      setUploadingData(false);
    }
  }, [invalidateAsyncReads, pushEvent, token, uploadingData, reportFailure, setSnapshot]);

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
    dismissOperationWarning: () => setOperationWarning(null),
    selectDemoScenario,
    leaveDemo,
    demoScenarios,
    writesDisabled: source !== 'live' || loading || operationWarning !== null,
    busy: rebuilding || uploadingData,
    isDemo: source === 'demo',
    loading,
    error,
    snapshot,
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
    pendingDelta,
    canRejectDelta: baseline !== null,
    policyComparison,
    policyComparisonLoading,
    policyComparisonError,
    events,
    signIn,
    requestLoginCode,
    signInWithCode,
    signOut,
    refresh,
    selectEngineer,
    clearFocus,
    selectRequest,
    selectUnassignedOffset,
    applyRoutingSettings,
    acceptDelta,
    rejectDelta,
    setMode,
    refreshPolicyComparison,
    updateEngineerAvailability,
    linkEngineerLogin,
    unlinkEngineerLogin,
    uploadDataset,
    importOfficialTzDataset,
    resolveAlert,
    setAttendanceOptOut,
    markNoticeSeen,
    closeShift,
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
    left.windowLatenessToleranceSec === right.windowLatenessToleranceSec &&
    left.trafficEnabled === right.trafficEnabled &&
    left.equipmentEnabled === right.equipmentEnabled &&
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
    departureLatenessToleranceSec: 0,
    taskStartLatenessToleranceSec: 0,
    windowLatenessToleranceSec: 0,
    trafficEnabled: true,
    equipmentEnabled: true,
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Не удалось выполнить запрос';
}

function engineerName(snapshot: DashboardSnapshot, engineerId: string): string {
  return snapshot.engineers.find((item) => item.id === engineerId)?.displayName ?? engineerId;
}
