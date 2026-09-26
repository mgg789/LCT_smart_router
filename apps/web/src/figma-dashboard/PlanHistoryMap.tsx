import { useState } from 'react';
import type { PlanView } from '../api/types';
import { DayMap } from '../components/DayMap';

/** Compare durable route geometry; historical routes never inherit live moving markers. */
export function PlanHistoryMap({
  previous,
  canRestore,
  busy,
  onRestore,
  ...props
}: Parameters<typeof DayMap>[0] & {
  previous: PlanView | null;
  canRestore: boolean;
  busy: boolean;
  onRestore: () => void;
}) {
  const [beforeRevision, setBeforeRevision] = useState<number | null>(null);
  const revision = props.snapshot.plan.plan?.revision;
  const historical = beforeRevision === revision && previous !== null;
  const snapshot = historical
    ? {
        ...props.snapshot,
        nowAt: previous.planAsOf,
        plan: { ...props.snapshot.plan, plan: previous },
      }
    : props.snapshot;
  return (
    <>
      <DayMap
        {...props}
        snapshot={snapshot}
        progressByEngineer={historical ? new Map() : props.progressByEngineer}
        completedByEngineer={historical ? new Map() : props.completedByEngineer}
        handoffs={historical ? [] : props.handoffs}
      />
      {previous && (
        <section
          aria-label="Сравнение маршрутов до и после"
          className="absolute bottom-12 left-4 z-20 flex items-center gap-2 rounded-2xl bg-white p-3 text-sm shadow-lg"
        >
          <button
            type="button"
            aria-pressed={historical}
            onClick={() => setBeforeRevision(revision ?? null)}
            className="rounded-full px-3 py-2 aria-pressed:bg-figma-bee"
          >
            До · {previous.revision}
          </button>
          <button
            type="button"
            aria-pressed={!historical}
            onClick={() => setBeforeRevision(null)}
            className="rounded-full px-3 py-2 aria-pressed:bg-figma-bee"
          >
            После · {revision}
          </button>
          <button
            type="button"
            onClick={onRestore}
            disabled={!canRestore || busy}
            title={
              canRestore
                ? 'Создать новую ревизию из предыдущего плана'
                : 'Предыдущий план больше не соответствует текущим условиям'
            }
            className="rounded-full border border-figma-line px-3 py-2 disabled:opacity-40"
          >
            Вернуть прежний план
          </button>
        </section>
      )}
    </>
  );
}
