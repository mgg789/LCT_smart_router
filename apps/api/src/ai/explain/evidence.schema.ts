import { z } from 'zod';

/**
 * `PlanEvidence` / `RequestEvidence` / `CandidateEvidence`, as Router Core actually emits
 * them (`core/contracts.py`, `core/schemas/router-result-1.0.json`, `core/evidence.py`).
 *
 * This is the "next contract" `docs/api.md` section 10 names: `main_evidence` and
 * `baseline_evidence` travel inside `RouterResult.payload` already (see
 * `src/routing/router-gateway/result.types.ts`'s `routerResultSchema`, a `looseObject`
 * that keeps them verbatim), but nothing downstream parses or serves them yet. This module
 * is that parse step -- Zod-validated the same way every other Router boundary in this
 * codebase is, so a malformed package is a visible, honest failure instead of a
 * half-trusted read.
 *
 * Field names stay snake_case, matching the raw JSON Router sends (Pydantic's default
 * serialization of `core/contracts.py`'s attribute names, with no camelCase alias
 * configured) -- the same convention `result.types.ts` already uses for `main`/`baseline`.
 */

const skill = z.enum(['local', 'connection', 'emergency']);
const transport = z.enum(['car', 'walk', 'bike', 'transit']);
const equipmentType = z.enum(['router', 'set_top_box', 'smart_speaker']);
const unixSeconds = z.number().int();

/** A checkable ground for a decision -- never a hand-written sentence (context/11, D-3). */
const evidenceReason = z.object({
  code: z.string().min(1),
  text: z.string(),
  basis: z.enum(['constraint_check', 'calculation_outcome']),
  facts: z.record(z.string(), z.unknown()).default({}),
});

/** Structured compatibility and append checks for one engineer alternative. `blockers[]`
 *  is what actually answers "why not this engineer": a finite, checkable list rather than
 *  a generated sentence. */
export const candidateEvidenceSchema = z.object({
  engineer_id: z.string().min(1),
  label: z.string().nullable(),
  skills: z.array(skill),
  transport_type: transport,
  equipment_stock: z.number().int().nullable(),
  release_at: unixSeconds.nullable(),
  shift_end_at: unixSeconds,
  skill_match: z.boolean(),
  transport_match: z.boolean(),
  equipment_match: z.boolean(),
  available: z.boolean(),
  /** Proves the request fits an otherwise empty route. Not a claim about the current one. */
  solo_feasible: z.boolean(),
  /** Checks only the current route order with the request appended at the end -- not a
   *  claim that bounded search tried every position. */
  append_at_route_end_feasible: z.boolean(),
  append_start_at: unixSeconds.nullable(),
  append_end_at: unixSeconds.nullable(),
  append_incremental_travel_time_sec: z.number().int().nullable(),
  append_incremental_distance_km: z.number().nullable(),
  assigned_job_count: z.number().int().nonnegative(),
  blockers: z.array(z.string()),
});

/** Calculation-backed assignment facts for one request, deterministic UI and LLM input. */
export const requestEvidenceSchema = z.object({
  request_id: z.string().min(1),
  status: z.enum(['assigned', 'unassigned']),
  priority: z.enum(['normal', 'urgent']),
  required_skill: skill,
  required_transport: transport.nullable(),
  required_equipment: equipmentType.nullable(),
  service_duration_sec: z.number().int().nonnegative(),
  window_start_at: unixSeconds,
  window_end_at: unixSeconds,
  engineer_id: z.string().nullable(),
  stop_id: z.string().nullable(),
  predecessor_request_id: z.string().nullable(),
  arrival_at: unixSeconds.nullable(),
  start_at: unixSeconds.nullable(),
  end_at: unixSeconds.nullable(),
  waiting_time_sec: z.number().int().nullable(),
  window_start_offset_sec: z.number().int().nullable(),
  window_end_margin_sec: z.number().int().nullable(),
  travel_time_sec: z.number().int().nullable(),
  distance_km: z.number().nullable(),
  reason_codes: z.array(z.string()),
  reasons: z.array(evidenceReason),
  candidates: z.array(candidateEvidenceSchema),
});

/** Versioned evidence bundle kept separate from the route decision itself. */
export const planEvidenceSchema = z.object({
  schema_version: z.literal('1.0'),
  requests: z.array(requestEvidenceSchema),
});

export type CandidateEvidence = z.infer<typeof candidateEvidenceSchema>;
export type RequestEvidence = z.infer<typeof requestEvidenceSchema>;
export type PlanEvidence = z.infer<typeof planEvidenceSchema>;
export type EvidenceReason = z.infer<typeof evidenceReason>;
