import { z } from 'zod';

/**
 * `RouterResult` — what Router Core returns.
 *
 * The shape is fixed by context/33 section 8. It is validated on arrival rather than
 * trusted: the result crosses a process boundary, and a malformed package must be a
 * visible error instead of a half-applied plan.
 *
 * Distinctions the schema is built to preserve:
 *   * `ready` means the processing finished, not that every request was assigned and not
 *     that the plan may be applied;
 *   * `is_usable` separates an admissible plan from a variant that must not become the
 *     working plan. `false` does not prove global impossibility;
 *   * `metric_scope` marks the metrics as covering the task of this snapshot -- the
 *     remaining future -- not a whole day that has partly already happened.
 */

const unixSeconds = z.number().int();
const geoPoint = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });

/**
 * A checkable ground for a decision.
 *
 * Structured facts from the solver, never a hand-written sentence and never text a model
 * produced (context/11, D-3). `basis` separates "a constraint ruled this out" from
 * "the search did not find a variant", which are different claims.
 */
const reason = z.object({
  code: z.string().min(1),
  text: z.string(),
  basis: z.enum(['constraint_check', 'calculation_outcome']),
  facts: z.record(z.string(), z.unknown()).default({}),
});

const routeStop = z.object({
  stop_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['job', 'lunch', 'wait']),
  /** The request for a `job`; `null` for lunch and waiting. */
  request_id: z.string().min(1).nullable(),
  location: geoPoint,
  /** Computed schedule, not confirmed facts: arrival <= start <= end. */
  arrival_at: unixSeconds,
  start_at: unixSeconds,
  end_at: unixSeconds,
});

const routeLeg = z.object({
  leg_id: z.string().min(1),
  from_stop_id: z.string().min(1).nullable(),
  to_stop_id: z.string().min(1),
  departure_at: unixSeconds,
  arrival_at: unixSeconds,
  travel_time_sec: z.number().int().nonnegative(),
  distance_km: z.number().nonnegative(),
  geometry: z
    .object({ points: z.array(geoPoint) })
    .nullable()
    .optional(),
});

/** Distinguishable lunch outcomes; a lunch that did not fit is never shown as scheduled. */
const lunchResult = z.object({
  status: z.enum([
    'disabled',
    'already_taken',
    'scheduled',
    'skipped_for_work',
    'not_scheduled',
    'required_conflict',
  ]),
  stop_id: z.string().min(1).nullable(),
  reasons: z.array(reason).default([]),
  alert_id: z.string().min(1).nullable().optional(),
});

const routeMetrics = z.object({
  distance_km: z.number().nonnegative(),
  travel_time_sec: z.number().int().nonnegative(),
  work_time_sec: z.number().int().nonnegative(),
  waiting_time_sec: z.number().int().nonnegative(),
  lunch_time_sec: z.number().int().nonnegative(),
  assigned_count: z.number().int().nonnegative(),
});

const engineerRoute = z.object({
  engineer_id: z.string().min(1),
  start_location: geoPoint,
  start_at: unixSeconds.nullable(),
  finish_at: unixSeconds.nullable(),
  stops: z.array(routeStop).default([]),
  legs: z.array(routeLeg).default([]),
  lunch: lunchResult,
  metrics: routeMetrics,
  reasons: z.array(reason).default([]),
});

const assignment = z.object({
  request_id: z.string().min(1),
  /** Planning outcome only. There is no in_progress or completed here: stages belong to sys. */
  status: z.enum(['assigned', 'unassigned']),
  engineer_id: z.string().min(1).nullable(),
  stop_id: z.string().min(1).nullable(),
  reasons: z.array(reason).default([]),
});

const planMetrics = z.object({
  requests_total: z.number().int().nonnegative(),
  assigned_count: z.number().int().nonnegative(),
  unassigned_count: z.number().int().nonnegative(),
  urgent_total: z.number().int().nonnegative(),
  urgent_assigned_count: z.number().int().nonnegative(),
  /** Engineers with at least one assigned request -- not counting one who only has lunch. */
  engineers_used: z.number().int().nonnegative(),
  distance_km: z.number().nonnegative(),
  travel_time_sec: z.number().int().nonnegative(),
  work_time_sec: z.number().int().nonnegative(),
  waiting_time_sec: z.number().int().nonnegative(),
  lunch_time_sec: z.number().int().nonnegative(),
});

const planningAlert = z.object({
  alert_id: z.string().min(1),
  code: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  engineer_ids: z.array(z.string()).default([]),
  request_ids: z.array(z.string()).default([]),
  reasons: z.array(reason).default([]),
  /**
   * A verified restore option, or null. A guess is never presented as a guaranteed fix
   * (context/33 section 6).
   */
  restore_option: z
    .object({ engineer_id: z.string().min(1), reject_request_ids: z.array(z.string()) })
    .nullable()
    .optional(),
});

export const planSchema = z.object({
  is_usable: z.boolean(),
  metric_scope: z.literal('snapshot_remaining'),
  routes: z.array(engineerRoute).default([]),
  /** Exactly one outcome per request of the snapshot. */
  assignments: z.array(assignment).default([]),
  summary: planMetrics,
  alerts: z.array(planningAlert).default([]),
});

const diagnostic = z.object({
  code: z.string().min(1),
  message: z.string(),
  field_path: z.string().nullable().optional(),
  entity_id: z.string().nullable().optional(),
});

/**
 * The package as sys reads it.
 *
 * Deliberately a *loose* object: Router V2 also returns `input_publication_id`,
 * `policy_id`, `policy_criteria`, `search_path`, `technical_settings`, `main_evidence` and
 * `baseline_evidence` (context/33 section 8, D-22). sys does not act on them yet, but the
 * Data Layer is required to keep the accepted package whole, evidence included
 * (context/37 section 4.5) -- and a stripping parser would throw it away silently at the
 * door. Unknown fields survive into the stored payload; only the fields declared below are
 * ever acted upon.
 */
export const routerResultSchema = z.looseObject({
  schema_version: z.string().min(1),
  /** State of getting a new result, not the status of any request. */
  status: z.enum(['pending', 'ready', 'error']),
  result_id: z.string().min(1).nullable(),
  /** Hash of the snapshot actually used. */
  input_hash: z.string().min(1).nullable(),
  planning_as_of: unixSeconds.nullable(),
  /** When the result was produced; not a substitute for `planning_as_of`. */
  computed_at: unixSeconds.nullable(),
  /** Version of the map and technical settings actually used. */
  router_context_version: z.string().min(1).nullable(),
  main: planSchema.nullable(),
  baseline: planSchema.nullable(),
  /** Errors of preparation or computation -- not a list of unassigned requests. */
  errors: z.array(diagnostic).default([]),
});

export type RouterResult = z.infer<typeof routerResultSchema>;
export type RouterPlan = z.infer<typeof planSchema>;
export type RouterAssignment = z.infer<typeof assignment>;
export type RouterRoute = z.infer<typeof engineerRoute>;
export type RouterAlert = z.infer<typeof planningAlert>;
export type RouterReason = z.infer<typeof reason>;
