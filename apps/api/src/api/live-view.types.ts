import type { PlanRouteView, PlanStopView } from './plan-view';
import type { RequestView } from './request-view';

export interface LiveWorkdayView {
  readonly id: string | null;
  readonly status: 'pending' | 'running' | 'finished';
  readonly workDate: string;
  readonly logicalStartAt: number;
  readonly logicalEndAt: number;
  readonly startedAtWallSec: number | null;
  readonly liveNow: number;
  readonly speedDurationSec: number | null;
  readonly speedFactor: number;
  readonly engineerStartDeadlineAt: number;
  readonly requestCount: number;
}

export interface LiveEngineerStateView {
  readonly id: string;
  readonly name: string;
  readonly lineStatus: 'pending' | 'online' | 'no_show_offline' | 'technical_break';
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
}

export interface DispatchLiveView {
  readonly workday: LiveWorkdayView;
  readonly engineers: LiveEngineerStateView[];
  /** Finished/cancelled/silently elapsed visits retained after a remaining-day replan. */
  readonly history: ReadonlyArray<{
    readonly request: RequestView;
    readonly engineerId: string | null;
    readonly stop: PlanStopView | null;
    readonly outcome: 'completed' | 'cancelled' | 'assumed_completed';
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
