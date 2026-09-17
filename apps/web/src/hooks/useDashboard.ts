import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DashboardApiError,
  loadDashboardSnapshot,
  loadPolicyComparison,
  loginDispatcher,
  selectRoutingPolicy,
  setDispatchMode,
  setEngineerAvailability,
  setLunchesEnabled,
  signOutDispatcher,
  uploadDataPackage,
} from '../api/client';
import type {
  DashboardSnapshot,
  DataUploadFile,
  DataUploadSummary,
  PlanDelta,
  PolicyComparisonResponse,
  PolicyId,
} from '../api/types';
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

const SESSION_KEY = 'lct.dispatcher.session';
const REBUILD_TIMEOUT_MS = 45_000;

export interface DayEvent {
  readonly id: string;
  readonly at: number;
  readonly text: string;
}

interface RoutingBaseline {
  readonly snapshot: DashboardSnapshot;
  readonly policyId: PolicyId;
  readonly lunchesEnabled: boolean;
}

/** Owns authentication and the live Dashboard-to-backend state flow. */
export function useDashboard() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(SESSION_KEY));
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
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
      setToken(null);
      setSnapshot(null);
      setFocus({ engineerId: null, requestId: null });
      setLoading(false);
      setError(reason);
    },
    [invalidateAsyncReads],
  );

  const refresh = useCallback(async () => {
    if (!token || refreshInFlight.current) {
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
      if (cause instanceof DashboardApiError && cause.status === 401) {
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
  }, [handleSessionFailure, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!token || rebuilding) {
      return;
    }
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [rebuilding, refresh, token]);

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

  const signIn = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      setError(null);
      try {
        const session = await loginDispatcher(email, password);
        invalidateAsyncReads();
        sessionStorage.setItem(SESSION_KEY, session.token);
        setToken(session.token);
      } catch (cause) {
        setError(errorMessage(cause));
        setLoading(false);
      }
    },
    [invalidateAsyncReads],
  );

  const signOut = useCallback(async () => {
    invalidateAsyncReads();
    if (token) {
      await signOutDispatcher(token).catch(() => undefined);
    }
    sessionStorage.removeItem(SESSION_KEY);
    setToken(null);
    setSnapshot(null);
    setFocus({ engineerId: null, requestId: null });
    setPendingDelta(null);
    setBaseline(null);
    setPolicyComparison(null);
    setPolicyComparisonError(null);
    setError(null);
  }, [invalidateAsyncReads, token]);

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
      lunchesEnabled: boolean,
      reason: string,
      keepBaseline: boolean,
    ) => {
      if (!token || !snapshot || rebuilding) {
        return false;
      }
      const previous = snapshot;
      const solveStartedAtMs = performance.now();
      const previousResultId = previous.plan.appliedResult?.resultId ?? null;
      const previousRevision = previous.plan.plan?.revision ?? null;
      let expectedInputHash: string | null = null;
      let expectedContextVersion = previous.routerContextVersion;
      invalidateAsyncReads();
      setRebuilding(true);
      setPendingDelta(null);
      setError(null);
      pushEvent(`${reason}. Router пересчитывает план…`);
      if (keepBaseline) {
        setBaseline({
          snapshot: previous,
          policyId: previous.policyId,
          lunchesEnabled: previous.lunchesEnabled,
        });
      }
      try {
        if (lunchesEnabled !== previous.lunchesEnabled) {
          expectedContextVersion = await setLunchesEnabled(token, lunchesEnabled);
        }
        if (nextPolicy !== previous.policyId) {
          expectedInputHash = await selectRoutingPolicy(token, nextPolicy);
        }
        const next = await waitForRebuild(token, {
          previousRevision,
          previousResultId,
          policyId: nextPolicy,
          lunchesEnabled,
          inputHash: expectedInputHash,
          routerContextVersion: expectedContextVersion,
        });
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
        setError(errorMessage(cause));
        pushEvent(`Перестроение не завершено: ${errorMessage(cause)}`);
        await refresh();
        return false;
      } finally {
        setRebuilding(false);
      }
    },
    [invalidateAsyncReads, pushEvent, rebuilding, refresh, snapshot, token],
  );

  const applyRoutingSettings = useCallback(
    (policyId: PolicyId, lunchesEnabled: boolean) => {
      if (!snapshot) {
        return;
      }
      const changes = [
        policyId !== snapshot.policyId ? `политика ${policyId}` : null,
        lunchesEnabled !== snapshot.lunchesEnabled
          ? lunchesEnabled
            ? 'обеды включены'
            : 'обеды выключены'
          : null,
      ].filter((item): item is string => item !== null);
      if (changes.length > 0) {
        void rebuild(policyId, lunchesEnabled, changes.join(', '), true);
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
      baseline.lunchesEnabled,
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
      if (!token) {
        return;
      }
      invalidateAsyncReads();
      setError(null);
      try {
        await setDispatchMode(token, mode);
        await refresh();
        pushEvent(
          mode === 'manual' ? 'Включён ручной режим.' : 'Восстановлен автоматический режим.',
        );
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [invalidateAsyncReads, pushEvent, refresh, token],
  );

  const refreshPolicyComparison = useCallback(async () => {
    if (!token || rebuilding || comparisonInFlight.current) {
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
      if (cause instanceof DashboardApiError && cause.status === 401) {
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
  }, [handleSessionFailure, rebuilding, token]);

  const updateEngineerAvailability = useCallback(
    async (engineerId: string, availability: 'online' | 'offline') => {
      if (!token || !snapshot || rebuilding) {
        return;
      }
      const previous = snapshot;
      const previousResultId = previous.plan.appliedResult?.resultId ?? null;
      const previousRevision = previous.plan.plan?.revision ?? null;
      const solveStartedAtMs = performance.now();
      invalidateAsyncReads();
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
        const next = await waitForRebuild(token, {
          previousRevision,
          previousResultId,
          policyId: previous.policyId,
          lunchesEnabled: previous.lunchesEnabled,
          inputHash,
          routerContextVersion: previous.routerContextVersion,
        });
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
        setError(errorMessage(cause));
        pushEvent(
          `Не удалось подтвердить перестроение после смены статуса: ${errorMessage(cause)}`,
        );
        await refresh();
      } finally {
        setAvailabilityPendingId(null);
        setRebuilding(false);
      }
    },
    [invalidateAsyncReads, pushEvent, rebuilding, refresh, snapshot, token],
  );

  const uploadDataset = useCallback(
    async (file: DataUploadFile): Promise<DataUploadSummary> => {
      if (!token || uploadingData) {
        throw new Error('Загрузка данных уже выполняется');
      }
      invalidateAsyncReads();
      setUploadingData(true);
      setError(null);
      try {
        const summary = await uploadDataPackage(token, file);
        try {
          const next = await loadDashboardSnapshot(token);
          setSnapshot(next);
        } catch (refreshCause) {
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
        setError(errorMessage(cause));
        throw cause;
      } finally {
        setUploadingData(false);
      }
    },
    [invalidateAsyncReads, pushEvent, token, uploadingData],
  );

  return {
    authenticated: token !== null,
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
    uploadDataset,
  };
}

async function waitForRebuild(
  token: string,
  expected: RebuildExpectation,
): Promise<DashboardSnapshot> {
  const deadline = Date.now() + REBUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await loadDashboardSnapshot(token);
    if (isExpectedRebuildApplied(snapshot, expected)) {
      return snapshot;
    }
    await delay(750);
  }
  throw new Error('Router не успел применить новую ревизию за 45 секунд');
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
