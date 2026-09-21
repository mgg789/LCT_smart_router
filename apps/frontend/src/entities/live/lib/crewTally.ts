import type { LiveEngineerState } from '../model/types';

export interface CrewTally {
  /** Visits behind the crew: finished by hand or carried past by the schedule. */
  done: number;
  /** Everything the crew has had today: done, under way and still ahead. */
  total: number;
}

/**
 * The mockup's «выполнено N/M» for one crew.
 *
 * The plan holds only the work ahead, so it cannot say what is behind; the LIVE
 * workday can, per crew, in `stats`. Done counts visits finished by hand and
 * those the schedule carried past without a mark — the same sum `apps/web`
 * shows. The total adds the visits still in the crew's route and the one it has
 * started, when a replan has already taken that one out of the route.
 *
 * `remainingRequestIds` are the requests of the crew's current route.
 */
export function crewTally(
  state: LiveEngineerState | undefined,
  remainingRequestIds: readonly string[],
): CrewTally | null {
  if (!state) return null;
  const done = state.stats.completedCount + state.stats.assumedCompletedCount;
  const active = state.activeRequestId;
  const activeOutsideRoute = active !== null && !remainingRequestIds.includes(active) ? 1 : 0;
  return { done, total: done + remainingRequestIds.length + activeOutsideRoute };
}
