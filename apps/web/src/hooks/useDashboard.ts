import { useCallback, useMemo, useState } from 'react';
import { loadDashboardSnapshot } from '../api/client';
import type { DashboardSnapshot, PlanDelta, PolicyId } from '../api/types';
import {
  assignmentFor,
  computePlanDelta,
  currentStopId,
  engineerSummaries,
  plannedActivity,
  planWithLunches,
  requestById,
  routeForEngineer,
  unassignedRequests,
  withLunches,
  withPlan,
  withPolicy,
} from '../domain/dashboard';
import {
  CURRENT_PLAN,
  FOCUS_ENGINEER_ID,
  FOCUS_REQUEST_ID,
  REBUILT_PLAN,
} from '../fixtures/dev-day';

export interface DayEvent {
  readonly id: string;
  readonly at: number;
  readonly text: string;
}

export function useDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(() => loadDashboardSnapshot());
  const [selectedEngineerId, setSelectedEngineerId] = useState<string | null>(FOCUS_ENGINEER_ID);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(FOCUS_REQUEST_ID);
  const [rebuilding, setRebuilding] = useState(false);
  const [pendingDelta, setPendingDelta] = useState<PlanDelta | null>(null);
  const [baseline, setBaseline] = useState<DashboardSnapshot | null>(null);
  const [events, setEvents] = useState<DayEvent[]>([
    {
      id: 'evt-open',
      at: snapshot.nowAt,
      text: 'Показан применённый план rev.3, построенный в 11:42',
    },
  ]);

  const engineers = useMemo(() => engineerSummaries(snapshot), [snapshot]);
  const unassigned = useMemo(() => unassignedRequests(snapshot), [snapshot]);
  const selectedRoute = selectedEngineerId ? routeForEngineer(snapshot, selectedEngineerId) : null;
  const selectedRequest = selectedRequestId ? requestById(snapshot, selectedRequestId) : null;
  const selectedAssignment = selectedRequestId ? assignmentFor(snapshot, selectedRequestId) : null;
  const selectedEngineer = selectedEngineerId
    ? (snapshot.engineers.find((item) => item.id === selectedEngineerId) ?? null)
    : null;
  const selectedActivity = selectedEngineerId
    ? plannedActivity(snapshot, selectedEngineerId)
    : null;
  const unassignedIndex = selectedRequestId
    ? unassigned.findIndex((item) => item.id === selectedRequestId)
    : -1;

  const pushEvent = useCallback(
    (text: string) => {
      setEvents((prev) => [{ id: `evt-${prev.length + 1}`, at: snapshot.nowAt, text }, ...prev]);
    },
    [snapshot.nowAt],
  );

  const clearFocus = useCallback(() => {
    setSelectedEngineerId(null);
    setSelectedRequestId(null);
  }, []);

  const selectEngineer = useCallback(
    (engineerId: string) => {
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
      setSelectedRequestId(requestId);
      const owner = snapshot.plan.plan?.assignments.find((item) => item.requestId === requestId);
      if (owner?.engineerId) {
        setSelectedEngineerId(owner.engineerId);
      }
    },
    [snapshot],
  );

  const runRebuild = useCallback(
    (nextPolicy: PolicyId, lunchesEnabled: boolean, policyChanged: boolean, reason: string) => {
      if (rebuilding) {
        return;
      }
      const previous = snapshot;
      setRebuilding(true);
      setPendingDelta(null);
      pushEvent(`${reason}. Пересборка…`);
      window.setTimeout(() => {
        const source =
          policyChanged || previous.plan.plan?.revision === REBUILT_PLAN.revision
            ? REBUILT_PLAN
            : CURRENT_PLAN;
        const nextPlan = planWithLunches(
          {
            ...source,
            planAsOf: previous.nowAt + 90,
            appliedAt: previous.nowAt + 90,
          },
          lunchesEnabled,
        );
        const next = withLunches(
          withPolicy(withPlan(previous, nextPlan), nextPolicy),
          lunchesEnabled,
        );
        const currentPlan = previous.plan.plan ?? planWithLunches(CURRENT_PLAN, false);
        setBaseline(previous);
        setSnapshot(next);
        setPendingDelta(computePlanDelta(currentPlan, nextPlan, 1180));
        setRebuilding(false);
        pushEvent('План пересобран. Дельта ждёт принятия.');
      }, 1200);
    },
    [pushEvent, rebuilding, snapshot],
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

  const applyRoutingSettings = useCallback(
    (policyId: PolicyId, lunchesEnabled: boolean) => {
      const policyChanged = policyId !== snapshot.policyId;
      const lunchChanged = lunchesEnabled !== snapshot.lunchesEnabled;
      if (!policyChanged && !lunchChanged) {
        return;
      }
      const parts = [
        policyChanged ? `Политика сменена на ${policyId}` : null,
        lunchChanged ? (lunchesEnabled ? 'Обеды включены' : 'Обеды выключены') : null,
      ].filter((item): item is string => item !== null);
      runRebuild(policyId, lunchesEnabled, policyChanged, parts.join('. '));
    },
    [runRebuild, snapshot.lunchesEnabled, snapshot.policyId],
  );

  const acceptDelta = useCallback(() => {
    setPendingDelta(null);
    setBaseline(null);
    pushEvent('Дельта принята. Показан новый рабочий план.');
  }, [pushEvent]);

  const rejectDelta = useCallback(() => {
    if (baseline) {
      setSnapshot(baseline);
    }
    setPendingDelta(null);
    setBaseline(null);
    pushEvent('Дельта отклонена. Вернули предыдущий план.');
  }, [baseline, pushEvent]);

  const setMode = useCallback(
    (mode: 'auto' | 'manual') => {
      setSnapshot((prev) => ({
        ...prev,
        plan: { ...prev.plan, mode, modeVersion: prev.plan.modeVersion + 1 },
      }));
      pushEvent(mode === 'manual' ? 'Включён MANUAL' : 'Возврат в AUTO');
    },
    [pushEvent],
  );

  return {
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
