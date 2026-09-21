import type { PlanRouteView, PlanStopView } from './plan-view';
import type { RequestView } from './request-view';

export interface LiveWorkdayView {
  readonly id: string | null;
  readonly status: 'pending' | 'running' | 'finished';
  readonly workDate: string;
  readonly logicalStartAt: number;
  readonly logicalEndAt: number;
  readonly startedAtWallSec: number | null;
  readonly finishedAt: number | null;
  readonly completionReason: 'schedule_exhausted' | 'logical_end' | null;
  readonly liveNow: number;
  readonly speedDurationSec: number | null;
  readonly speedFactor: number;
  readonly engineerStartDeadlineAt: number;
  readonly requestCount: number;
  readonly stats: LiveStatsView;
}

export interface LiveStatsView {
  readonly completedCount: number;
  readonly cancelledCount: number;
  readonly assumedCompletedCount: number;
  readonly problemCount: number;
  readonly technicalBreakCount: number;
}

export interface LiveRoutePointView {
  readonly kind: 'start' | 'job' | 'lunch';
  readonly requestId: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly at: number;
}

/** Factual traversal projection; a route revision never moves this anchor by itself. */
export interface LiveRouteProgressView {
  readonly phase: 'not_started' | 'traveling' | 'on_site' | 'lunch' | 'finished';
  /** Immutable depot/start vertex captured when the dispatcher starts this LIVE day. */
  readonly origin: LiveRoutePointView;
  readonly anchor: LiveRoutePointView;
  readonly lunch: LiveRoutePointView | null;
  readonly next: LiveRoutePointView | null;
  readonly occurredAt: number;
}

export interface LiveEngineerStateView {
  readonly id: string;
  readonly name: string;
  readonly lineStatus: 'pending' | 'online' | 'no_show_offline' | 'technical_break';
  readonly lineStartedAt: number | null;
  readonly noShowAt: number | null;
  readonly lunchInterval: { readonly startAt: number; readonly endAt: number } | null;
  readonly availability: string;
  readonly activeRequestId: string | null;
  readonly technicalBreak: {
    readonly startedAt: number;
    readonly plannedEndAt: number;
    readonly overdueAt: number;
  } | null;
  readonly pendingDelayProblem: {
    readonly requestId: string;
    readonly note: string;
    readonly additionalDurationSec: number;
  } | null;
  readonly routeState: 'active' | 'awaiting_plan' | 'exhausted';
  /** Personal readiness after 17:00; independent of dispatcher alert resolution. */
  readonly canFinishDay: boolean;
  readonly progress: LiveRouteProgressView | null;
  readonly stats: LiveStatsView;
}

export interface DispatchLiveView {
  readonly workday: LiveWorkdayView;
  readonly engineers: LiveEngineerStateView[];
  /** Technical-stop markers reconstructed from the durable operation journal. */
  readonly breaks: ReadonlyArray<{
    readonly id: string;
    readonly engineerId: string;
    readonly startedAt: number;
    readonly plannedEndAt: number;
    readonly endedAt: number | null;
  }>;
  /** Finished/cancelled/silently elapsed visits retained after a remaining-day replan. */
  readonly history: ReadonlyArray<{
    readonly request: RequestView;
    readonly engineerId: string | null;
    readonly stop: PlanStopView | null;
    readonly outcome: 'completed' | 'cancelled' | 'assumed_completed';
    readonly terminalAt: number;
  }>;
}

export interface EngineerLiveView {
  readonly workday: LiveWorkdayView;
  readonly engineer: LiveEngineerStateView;
  readonly route: PlanRouteView | null;
  readonly current: {
    readonly request: RequestView;
    readonly stop: PlanStopView | null;
    readonly phase: 'awaiting_window' | 'ready_to_start' | 'in_progress';
    readonly expectedCompletionAt: number | null;
    readonly overrunAt: number | null;
  } | null;
  readonly lunch: { readonly startedAt: number; readonly endAt: number } | null;
}
