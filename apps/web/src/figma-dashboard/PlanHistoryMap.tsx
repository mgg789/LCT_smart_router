import type { PlanView } from '../api/types';
import { DayMap } from '../components/DayMap';
import type { PlanHistorySelection } from './PlanHistorySelector';

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
  const revision = props.snapshot.plan.plan?.revision;
  const historical =
    historyOpen &&
    historySelection === 'previous' &&
    previous !== null &&
    typeof revision === 'number';
  const snapshot = historical
    ? {
        ...props.snapshot,
        nowAt: previous.planAsOf,
        plan: { ...props.snapshot.plan, plan: previous },
      }
    : props.snapshot;
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
