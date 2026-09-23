/**
 * The LIVE workday as the dispatcher sees it (`GET /dispatch/live`).
 *
 * Only what this frontend reads is typed; the endpoint carries more (progress
 * geometry, breaks) that no screen here draws yet.
 */
export interface LiveStats {
  /** Visits the crew explicitly finished. */
  completedCount: number;
  cancelledCount: number;
  /** Visits the schedule carried past without a mark — counted as done, not confirmed. */
  assumedCompletedCount: number;
  problemCount: number;
  technicalBreakCount: number;
}

export type LineStatus = 'pending' | 'online' | 'no_show_offline' | 'technical_break';

export interface LiveEngineerState {
  id: string;
  name: string;
  lineStatus: LineStatus;
  lineStartedAt: number | null;
  /** The visit this crew has started and not yet closed. */
  activeRequestId: string | null;
  routeState: 'active' | 'awaiting_plan' | 'exhausted';
  stats: LiveStats;
}

export interface LiveWorkday {
  id: string | null;
  status: 'pending' | 'running' | 'finished';
  workDate: string;
  /** The day's own clock, in Unix seconds — not the wall clock. */
  liveNow: number;
  requestCount: number;
  stats: LiveStats;
}

export interface LiveHistoryEntry {
  /** The full request card travels with the entry; only what is read is typed. */
  request: { id: string; addressText: string; contactName: string | null };
  engineerId: string | null;
  /** Where the visit sat in the plan when it closed, if it was planned at all. */
  stop: { sequence: number; arrivalAt: number; startAt: number; endAt: number } | null;
  outcome: 'completed' | 'cancelled' | 'assumed_completed';
  terminalAt: number;
}

export interface DispatchLiveView {
  workday: LiveWorkday;
  engineers: LiveEngineerState[];
  /** Closed visits, kept after the rest of the day is replanned. */
  history: LiveHistoryEntry[];
}
