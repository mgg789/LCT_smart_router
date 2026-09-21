import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EvidenceReader } from '../../src/ai/explain/evidence.reader';

/**
 * `EvidenceReader` is the one place `main_evidence`/`baseline_evidence` are parsed out of
 * a stored `RouterResult.payload` (docs/api.md section 10's "next contract"). Every read
 * must be honest about absence and must never drop `basis` -- the whole reason the
 * explainer can tell "a bounded search found nothing" (`calculation_outcome`) apart from
 * "a verified rule ruled it out" (`constraint_check`).
 */
describe('EvidenceReader', () => {
  const reader = new EvidenceReader();

  const candidate = {
    engineer_id: 'eng-1',
    label: 'Иван',
    skills: ['connection'],
    transport_type: 'car',
    equipment_stock: null,
    release_at: null,
    shift_end_at: 100,
    skill_match: true,
    transport_match: true,
    equipment_match: true,
    available: true,
    solo_feasible: true,
    append_at_route_end_feasible: false,
    append_start_at: null,
    append_end_at: null,
    append_incremental_travel_time_sec: null,
    append_incremental_distance_km: null,
    assigned_job_count: 1,
    blockers: ['current_route_append_infeasible'],
  };

  const requestEvidence = {
    request_id: 'req-1',
    status: 'unassigned',
    priority: 'normal',
    required_skill: 'connection',
    required_transport: null,
    required_equipment: null,
    service_duration_sec: 900,
    window_start_at: 100,
    window_end_at: 200,
    engineer_id: null,
    stop_id: null,
    predecessor_request_id: null,
    arrival_at: null,
    start_at: null,
    end_at: null,
    waiting_time_sec: null,
    window_start_offset_sec: null,
    window_end_margin_sec: null,
    travel_time_sec: null,
    distance_km: null,
    reason_codes: ['NO_FEASIBLE_ASSIGNMENT_FOUND'],
    reasons: [
      {
        code: 'NO_FEASIBLE_ASSIGNMENT_FOUND',
        text: 'bounded search found no variant',
        basis: 'calculation_outcome',
        facts: {},
      },
    ],
    candidates: [candidate],
  };

  const payload = {
    main_evidence: { schema_version: '1.0', requests: [requestEvidence] },
    baseline_evidence: null,
  };

  it('returns an honest empty shape when the payload carries no evidence at all', () => {
    const pair = reader.forRequest({}, 'req-1');
    assert.equal(pair.main, null);
    assert.equal(pair.baseline, null);
  });

  it('returns an honest empty shape for a non-object payload', () => {
    const pair = reader.forRequest(null, 'req-1');
    assert.equal(pair.main, null);
    assert.equal(pair.baseline, null);
  });

  it('reads the main package and finds the exact request; baseline stays null when absent', () => {
    const pair = reader.forRequest(payload, 'req-1');
    assert.ok(pair.main);
    assert.equal(pair.main?.request_id, 'req-1');
    assert.equal(pair.baseline, null);
  });

  it('preserves basis end to end -- calculation_outcome is never silently coerced', () => {
    const pair = reader.forRequest(payload, 'req-1');
    assert.equal(pair.main?.reasons[0]?.basis, 'calculation_outcome');
  });

  it('a request id absent from the package is an honest null, not an invented row', () => {
    const pair = reader.forRequest(payload, 'req-does-not-exist');
    assert.equal(pair.main, null);
  });

  it('a malformed evidence blob is treated as absent, not thrown', () => {
    const pair = reader.forRequest({ main_evidence: { not: 'valid' } }, 'req-1');
    assert.equal(pair.main, null);
  });

  it('forEngineerRoute filters the main package to one engineer, keeping candidates/blockers', () => {
    const rows = reader.forEngineerRoute(payload, 'eng-1');
    assert.equal(rows.length, 0); // this request's engineer_id is null, not eng-1
    const rows2 = reader.forEngineerRoute(
      {
        main_evidence: {
          schema_version: '1.0',
          requests: [{ ...requestEvidence, engineer_id: 'eng-1' }],
        },
      },
      'eng-1',
    );
    assert.equal(rows2.length, 1);
    assert.deepEqual(rows2[0]?.candidates[0]?.blockers, ['current_route_append_infeasible']);
  });
});
