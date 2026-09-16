import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DashboardApiError,
  loadDashboardSnapshot,
  loginDispatcher,
  selectRoutingPolicy,
  setDispatchMode,
  setLunchesEnabled,
  signOutDispatcher,
} from '../api/client';
import type { DashboardSnapshot, PlanDelta, PolicyId } from '../api/types';
import {
  assignmentFor,
  computePlanDelta,
  currentStopId,
  engineerSummaries,
  isExpectedRebuildApplied,
  plannedActivity,
  type RebuildExpectation,
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
  const [selectedEngineerId, setSelectedEngineerId] = useState<string | null>(null);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [pendingDelta, setPendingDelta] = useState<PlanDelta | null>(null);
  const [baseline, setBaseline] = useState<RoutingBaseline | null>(null);
  const [events, setEvents] = useState<DayEvent[]>([]);
  const refreshInFlight = useRef(false);

  const handleSessionFailure = useCallback((reason: string) => {
    sessionStorage.removeItem(SESSION_KEY);
    setToken(null);
    setSnapshot(null);
    setLoading(false);
    setError(reason);
  }, []);

  const refresh = useCallback(async () => {
    if (!token || refreshInFlight.current) {
      return null;
    }
    refreshInFlight.current = true;
    try {
      const next = await loadDashboardSnapshot(token);
      setSnapshot(next);
      setError(null);
      return next;
    } catch (cause) {
      if (cause instanceof DashboardApiError && cause.status === 401) {
        handleSessionFailure('Сессия закончилась. Войдите снова.');
        return null;
      }
      setError(errorMessage(cause));
      return null;
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
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

  useEffect(() => {
    if (!snapshot || selectedEngineerId) {
      return;
    }
    const firstRoute = snapshot.plan.plan?.routes[0];
    if (firstRoute) {
      setSelectedEngineerId(firstRoute.engineerId);
      setSelectedRequestId(firstRoute.stops.find((stop) => stop.requestId)?.requestId ?? null);
    }
  }, [selectedEngineerId, snapshot]);

  const engineers = useMemo(() => (snapshot ? engineerSummaries(snapshot) : []), [snapshot]);
  const unassigned = useMemo(() => (snapshot ? unassignedRequests(snapshot) : []), [snapshot]);
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
  const selectedActivity =
    snapshot && selectedEngineerId ? plannedActivity(snapshot, selectedEngineerId) : null;
  const unassignedIndex = selectedRequestId
    ? unassigned.findIndex((item) => item.id === selectedRequestId)
    : -1;

  const pushEvent = useCallback((text: string) => {
    setEvents((previous) => [
      { id: crypto.randomUUID(), at: Math.floor(Date.now() / 1000), text },
      ...previous,
    ]);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const session = await loginDispatcher(email, password);
      sessionStorage.setItem(SESSION_KEY, session.token);
      setToken(session.token);
    } catch (cause) {
      setError(errorMessage(cause));
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (token) {
      await signOutDispatcher(token).catch(() => undefined);
    }
    sessionStorage.removeItem(SESSION_KEY);
    setToken(null);
    setSnapshot(null);
    setPendingDelta(null);
    setBaseline(null);
    setError(null);
  }, [token]);

  const clearFocus = useCallback(() => {
    setSelectedEngineerId(null);
    setSelectedRequestId(null);
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
      setSelectedEngineerId(engineerId);
      const current = currentStopId(snapshot, engineerId);
      if (current) {
        setSelectedRequestId(current);
      }
    },
    [clearFocus, selectedEngineerId, snapshot],
  );

  const selectRequest = useCallback(
    (requestId: string) => {
      if (!snapshot) {
        return;
      }
      setSelectedRequestId(requestId);
      const owner = snapshot.plan.plan?.assignments.find((item) => item.requestId === requestId);
      if (owner?.engineerId) {
        setSelectedEngineerId(owner.engineerId);
      }
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
        setSelectedRequestId(request.id);
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
    [pushEvent, rebuilding, refresh, snapshot, token],
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
      setError(null);
      try {
        await setDispatchMode(token, mode);
        await refresh();
        pushEvent(mode === 'manual' ? 'Включён режим MANUAL.' : 'Восстановлен режим AUTO.');
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [pushEvent, refresh, token],
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
    selectedActivity,
    unassignedIndex,
    rebuilding,
    pendingDelta,
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
