/**
 * Dispatcher-facing view types.
 *
 * These mirror `apps/api` plan/request/engineer views so the dashboard can later
 * swap the fixture for `GET /api/v1/dispatch/*` without rewriting the screen.
 * Absolute times are Unix-epoch seconds; local formatting stays in the UI.
 */

export type PolicyId = 'compact' | 'fast' | 'sla' | 'balanced' | 'eco';

export interface PolicySpec {
  readonly policyId: PolicyId;
  readonly title: string;
  readonly description: string;
  readonly isDefault: boolean;
}

export interface RequestView {
  readonly id: string;
  readonly version: number;
  readonly lifecycle: 'draft' | 'submitted' | 'in_progress' | 'completed' | 'cancelled';
  readonly assignmentState: 'unassigned' | 'assigned' | 'in_progress' | 'done';
  readonly addressText: string;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly needsGeocoding: boolean;
  readonly workType: string | null;
  readonly workTypeTitle: string | null;
  readonly requiredSkill: string;
  readonly serviceDurationSec: number;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly priority: 'normal' | 'urgent';
  readonly contactName: string | null;
  readonly problemText: string | null;
  readonly createdAt: number;
  readonly submittedAt: number | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly cancelledAt: number | null;
}

export interface EngineerView {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly inputOrder: number;
  readonly skills: string[];
  readonly transportType: 'car' | 'walk' | 'bike' | 'transit';
  readonly region: string | null;
  readonly homeLat: number | null;
  readonly homeLon: number | null;
  readonly hasAccount: boolean;
}

export interface EngineerDayView {
  readonly engineerId: string;
  readonly workDate: string;
  readonly version: number;
  readonly shiftStartAt: number;
  readonly shiftEndAt: number;
  readonly availability: 'online' | 'offline' | 'technical_break';
  readonly expectedOnlineAt: number | null;
  readonly lunch: {
    readonly enabled: boolean;
    readonly durationSec: number | null;
    readonly windowStartAt: number | null;
    readonly windowEndAt: number | null;
    readonly required: boolean;
    readonly taken: boolean;
    readonly startedAt: number | null;
  };
}

export interface PlanStopView {
  readonly sequence: number;
  readonly kind: 'job' | 'lunch' | 'start';
  readonly requestId: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly arrivalAt: number;
  readonly startAt: number;
  readonly endAt: number;
}

export interface PlanRouteView {
  readonly engineerId: string;
  readonly startLat: number;
  readonly startLon: number;
  readonly startAt: number | null;
  readonly finishAt: number | null;
  readonly distanceKm: number;
  readonly travelTimeSec: number;
  readonly workTimeSec: number;
  readonly waitingTimeSec: number;
  readonly lunchTimeSec: number;
  readonly assignedCount: number;
  readonly lunchStatus: 'none' | 'planned' | 'taken' | 'skipped';
  readonly stops: PlanStopView[];
}

export interface ReasonFactor {
  readonly code: string;
  readonly ok?: boolean;
  readonly value?: number;
  readonly detail: string;
}

export interface ReasonAlternative {
  readonly engineerId: string;
  readonly blocked: boolean;
  readonly costDeltaMin?: number;
  readonly whyNot: string;
}

export interface AssignmentReasons {
  readonly assignment?: {
    readonly chosen: string | null;
    readonly factors: ReasonFactor[];
    readonly alternatives: ReasonAlternative[];
  };
  readonly sequence?: Array<{
    readonly swapWith: string;
    readonly costDeltaMin: number;
    readonly why: string;
  }>;
}

export interface PlanAssignmentView {
  readonly requestId: string;
  readonly status: 'assigned' | 'unassigned' | 'in_progress' | 'done';
  readonly engineerId: string | null;
  readonly reasons: AssignmentReasons;
}

export interface PlanView {
  readonly revision: number;
  readonly origin: 'auto' | 'manual';
  readonly planAsOf: number;
  readonly appliedAt: number;
  readonly routes: PlanRouteView[];
  readonly assignments: PlanAssignmentView[];
}

export interface AlertView {
  readonly id: string;
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly engineerIds: string[];
  readonly requestIds: string[];
  readonly reasons: string[];
  readonly restoreOption: string | null;
  readonly createdAt: number;
  readonly seenAt: number | null;
  readonly resolvedAt: number | null;
}

export interface DispatchPlanResponse {
  readonly mode: 'auto' | 'manual';
  readonly modeVersion: number;
  readonly plan: PlanView | null;
  readonly lastResult: {
    readonly resultId: string;
    readonly accepted: boolean;
    readonly rejectionCode: string | null;
    readonly receivedAt: number;
  } | null;
}

export interface DashboardSnapshot {
  readonly workDate: string;
  readonly timeZone: 'Europe/Moscow';
  readonly nowAt: number;
  readonly policyId: PolicyId;
  readonly lunchesEnabled: boolean;
  readonly policies: readonly PolicySpec[];
  readonly engineers: Array<EngineerView & { day: EngineerDayView | null }>;
  readonly requests: RequestView[];
  readonly plan: DispatchPlanResponse;
  readonly alerts: AlertView[];
}

export interface PlanDelta {
  readonly transferred: number;
  readonly shifted: number;
  readonly slaBefore: number;
  readonly slaAfter: number;
  readonly solveMs: number;
  readonly notes: string[];
}
