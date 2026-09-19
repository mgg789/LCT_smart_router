import { z } from 'zod';
import { requestJson } from './client';
import type { PlanRouteView, PlanStopView, RequestView } from './types';

export type LiveLineStatus = 'pending' | 'online' | 'no_show_offline' | 'technical_break';
export type LivePhase = 'awaiting_window' | 'ready_to_start' | 'in_progress';

export interface LiveWorkday {
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

export interface LiveEngineerState {
  readonly id: string;
  readonly name: string;
  readonly lineStatus: LiveLineStatus;
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

export interface EngineerLiveView {
  readonly workday: LiveWorkday;
  readonly engineer: LiveEngineerState;
  /** The just-applied route is included with the live snapshot for an atomic refresh. */
  readonly route: PlanRouteView | null;
  readonly current: {
    readonly request: RequestView;
    readonly stop: PlanStopView | null;
    readonly phase: LivePhase;
    readonly expectedCompletionAt: number | null;
    readonly overrunAt: number | null;
  } | null;
  readonly lunch: { readonly startedAt: number; readonly endAt: number } | null;
}

export interface DispatchLiveView {
  readonly workday: LiveWorkday;
  readonly engineers: LiveEngineerState[];
  readonly breaks: readonly LiveBreak[];
  /** Completed/cancelled visits retained only for the dispatcher pipeline after a replan. */
  readonly history: readonly LiveHistoryItem[];
}

/** A durable technical-break marker, independent of the latest solver route. */
export interface LiveBreak {
  readonly id: string;
  readonly engineerId: string;
  readonly startedAt: number;
  readonly plannedEndAt: number;
  readonly endedAt: number | null;
}

export interface LiveHistoryItem {
  readonly request: RequestView;
  readonly engineerId: string | null;
  readonly stop: PlanStopView | null;
  readonly outcome: 'completed' | 'cancelled' | 'assumed_completed';
}

const requestSchema: z.ZodType<RequestView> = z.object({
  id: z.string(),
  version: z.number().int(),
  lifecycle: z.enum(['draft', 'submitted', 'in_progress', 'completed', 'cancelled']),
  assignmentState: z.enum(['pending', 'unassigned', 'assigned', 'in_progress', 'done']),
  addressText: z.string(),
  region: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  needsGeocoding: z.boolean(),
  geocodeQuality: z.string().nullable(),
  requiredEquipment: z.enum(['router', 'set_top_box', 'smart_speaker']).nullable(),
  workType: z.string().nullable(),
  workTypeTitle: z.string().nullable(),
  requiredSkill: z.string(),
  normProfileCode: z.string().optional(),
  normativeTravelDurationSec: z.number().int().optional(),
  technicalDurationSec: z.number().int().optional(),
  documentationDurationSec: z.number().int().optional(),
  serviceDurationSec: z.number().int(),
  actualDurationSec: z.number().int().nullable().optional(),
  durationVarianceSec: z.number().int().nullable().optional(),
  windowStartAt: z.number().int(),
  windowEndAt: z.number().int(),
  priority: z.enum(['normal', 'urgent']),
  contactName: z.string().nullable(),
  problemText: z.string().nullable(),
  createdAt: z.number().int(),
  submittedAt: z.number().int().nullable(),
  startedAt: z.number().int().nullable(),
  expectedCompletionAt: z.number().int().nullable().optional(),
  continuationAvailableAt: z.number().int().nullable().optional(),
  overrunDetectedAt: z.number().int().nullable().optional(),
  assumedStartedAt: z.number().int().nullable().optional().default(null),
  assumedCompletedAt: z.number().int().nullable().optional().default(null),
  completedAt: z.number().int().nullable(),
  cancelledAt: z.number().int().nullable(),
});
const stopSchema: z.ZodType<PlanStopView> = z.object({
  sequence: z.number().int(),
  kind: z.enum(['job', 'lunch', 'wait', 'start']),
  requestId: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  arrivalAt: z.number().int(),
  startAt: z.number().int(),
  endAt: z.number().int(),
});
const workdaySchema: z.ZodType<LiveWorkday> = z.object({
  id: z.string().nullable(),
  status: z.enum(['pending', 'running', 'finished']),
  workDate: z.string(),
  logicalStartAt: z.number().int(),
  logicalEndAt: z.number().int(),
  startedAtWallSec: z.number().int().nullable(),
  liveNow: z.number().int(),
  speedDurationSec: z.number().int().nullable(),
  speedFactor: z.number().positive(),
  engineerStartDeadlineAt: z.number().int(),
  requestCount: z.number().int().nonnegative(),
});
const engineerSchema: z.ZodType<LiveEngineerState> = z.object({
  id: z.string(),
  name: z.string(),
  lineStatus: z.enum(['pending', 'online', 'no_show_offline', 'technical_break']),
  availability: z.string(),
  activeRequestId: z.string().nullable(),
  technicalBreak: z
    .object({
      startedAt: z.number().int(),
      plannedEndAt: z.number().int(),
      overdueAt: z.number().int(),
    })
    .nullable(),
  pendingDelayProblem: z
    .object({
      requestId: z.string(),
      note: z.string(),
      additionalDurationSec: z.number().int().positive(),
    })
    .nullable(),
});
const engineerLiveSchema: z.ZodType<EngineerLiveView> = z.object({
  workday: workdaySchema,
  engineer: engineerSchema,
  route: z.custom<PlanRouteView | null>((value) => value === null || typeof value === 'object'),
  current: z
    .object({
      request: requestSchema,
      stop: stopSchema.nullable(),
      phase: z.enum(['awaiting_window', 'ready_to_start', 'in_progress']),
      expectedCompletionAt: z.number().int().nullable(),
      overrunAt: z.number().int().nullable(),
    })
    .nullable(),
  lunch: z.object({ startedAt: z.number().int(), endAt: z.number().int() }).nullable(),
});
const dispatchLiveSchema: z.ZodType<DispatchLiveView> = z.object({
  workday: workdaySchema,
  engineers: z.array(engineerSchema),
  breaks: z
    .array(
      z.object({
        id: z.string(),
        engineerId: z.string(),
        startedAt: z.number().int(),
        plannedEndAt: z.number().int(),
        endedAt: z.number().int().nullable(),
      }),
    )
    .default([]),
  history: z
    .array(
      z.object({
        request: requestSchema,
        engineerId: z.string().nullable(),
        stop: stopSchema.nullable(),
        outcome: z.enum(['completed', 'cancelled', 'assumed_completed']),
      }),
    )
    .optional()
    .default([]),
});

export type EngineerLiveAction =
  | { readonly kind: 'online' }
  | { readonly kind: 'on_time'; readonly requestId: string }
  | { readonly kind: 'eta'; readonly requestId: string; readonly etaAt: number }
  | { readonly kind: 'start' | 'finish'; readonly requestId: string }
  | {
      readonly kind: 'problem';
      readonly requestId: string;
      readonly problemKind: 'delay' | 'missing_equipment' | 'other' | 'impossible';
      readonly note: string;
      readonly additionalDurationSec?: number;
      readonly missingEquipment?: 'router' | 'set_top_box' | 'smart_speaker';
    }
  | { readonly kind: 'break_start' | 'break_finish' };

/** Reads the dispatcher-wide live state. */
export function loadDispatchLive(token: string): Promise<DispatchLiveView> {
  return requestJson('/api/v1/dispatch/live', dispatchLiveSchema, token);
}
/** Reads only the signed-in engineer's actionable live state. */
export function loadEngineerLive(token: string): Promise<EngineerLiveView> {
  return requestJson('/api/v1/engineer/live', engineerLiveSchema, token);
}
/** Starts a prepared workday and returns the authoritative live snapshot. */
export function startLiveWorkday(token: string): Promise<DispatchLiveView> {
  return requestJson('/api/v1/dispatch/live/start', dispatchLiveSchema, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID() }),
  });
}
/** Records one engineer action and returns the state after its server-side effects. */
export function sendEngineerLiveAction(
  token: string,
  action: EngineerLiveAction,
): Promise<EngineerLiveView> {
  return requestJson('/api/v1/engineer/live/actions', engineerLiveSchema, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), ...action }),
  });
}
