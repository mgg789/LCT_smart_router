import type { DashboardSnapshot, PlanView } from '../api/types';
import { DayMap } from '../components/DayMap';
import type { PlanHistorySelection } from './PlanHistorySelector';

/** Selects the plan payload rendered by the map while the chooser is open. */
export function snapshotForPlanHistory(
  snapshot: DashboardSnapshot,
  previous: PlanView | null,
  historyOpen: boolean,
  historySelection: PlanHistorySelection,
): DashboardSnapshot {
  if (!historyOpen || historySelection !== 'previous' || previous === null) return snapshot;
  return {
    ...snapshot,
    nowAt: previous.planAsOf,
    plan: { ...snapshot.plan, plan: previous },
  };
}

/** Compare durable route geometry; historical routes never inherit live moving markers. */
export function PlanHistoryMap({
  previous,
  historyOpen,
  historySelection,
  ...props
}: Parameters<typeof DayMap>[0] & {
  previous: PlanView | null;
  historyOpen: boolean;
  historySelection: PlanHistorySelection;
}) {
  const historical = historyOpen && historySelection === 'previous' && previous !== null;
  const snapshot = snapshotForPlanHistory(props.snapshot, previous, historyOpen, historySelection);
  return (
    <DayMap
      {...props}
      snapshot={snapshot}
      progressByEngineer={historical ? new Map() : props.progressByEngineer}
      completedByEngineer={historical ? new Map() : props.completedByEngineer}
      handoffs={historical ? [] : props.handoffs}
    />
  );
}
