import { useEffect } from 'react';
import { create } from 'zustand';
import { useDispatchState } from '@/entities/plan';
import { notify, RECALC_TOAST_ID } from '@/shared/lib';

interface PendingRecalculation {
  /** Wall-clock moment the new task was published, in milliseconds. */
  since: number;
  /** Revision of the plan on screen when it was published; `null` if there was none. */
  revision: number | null;
  policyTitle: string;
}

interface RecalculationState {
  pending: PendingRecalculation | null;
  start: (pending: PendingRecalculation) => void;
  finish: () => void;
}

const useRecalculationStore = create<RecalculationState>()((set) => ({
  pending: null,
  start: (pending) => set({ pending }),
  finish: () => set({ pending: null }),
}));

/**
 * Marks the moment a new task went to the Router and puts up the
 * «Пересчёт маршрутов» notice.
 *
 * The contract reports no progress for a recalculation, so the notice's bar
 * runs without a share and says what is known instead: which policy is being
 * applied. It stays until the new plan arrives or the dispatcher closes it.
 */
export function beginRecalculation(revision: number | null, policyTitle: string): void {
  useRecalculationStore.getState().start({ since: Date.now(), revision, policyTitle });
  notify({
    id: RECALC_TOAST_ID,
    kind: 'progress',
    title: 'Пересчёт маршрутов',
    body: `Применяем политику «${policyTitle}»`,
    progress: null,
    durationMs: null,
  });
}

/**
 * Watches the plan while a recalculation is pending and, when a newer revision
 * lands, replaces the running notice with «Перерасчёт завершён» and how long it
 * took. The time is measured here, between publishing and seeing the new plan —
 * so it includes the polling interval, and says «около».
 */
export function useRecalculationNotice(): void {
  const plan = useDispatchState().data?.plan ?? null;
  const pending = useRecalculationStore((state) => state.pending);
  const finish = useRecalculationStore((state) => state.finish);

  useEffect(() => {
    if (!pending || !plan) return;
    if (pending.revision !== null && plan.revision <= pending.revision) return;

    const seconds = Math.max(1, Math.round((Date.now() - pending.since) / 1000));
    notify({
      id: RECALC_TOAST_ID,
      kind: 'done',
      title: 'Перерасчёт завершён',
      body: `Новый план по «${pending.policyTitle}» — около ${seconds} с`,
      href: '/plan',
    });
    finish();
  }, [pending, plan, finish]);
}
