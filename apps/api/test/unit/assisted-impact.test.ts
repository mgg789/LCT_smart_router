import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouterTaskSnapshot } from '../../src/routing/mount-data-eng/snapshot.types';
import {
  compareAssistedImpact,
  criticalImpactCovered,
  type WorkingPlanForImpact,
} from '../../src/routing/router-gateway/assisted-impact';
import { type RouterPlan, routerResultSchema } from '../../src/routing/router-gateway/result.types';
import { buildRouterResult } from '../support/router-result';

function plan(ids: string[], owners: string[] = ids.map(() => 'e1'), delay = 0): RouterPlan {
  const result = routerResultSchema.parse(
    buildRouterResult({
      resultId: 'test',
      inputHash: 'hash',
      contextVersion: 'ctx',
      planningAsOf: 100,
      assigned: ids.map((requestId, index) => ({
        requestId,
        engineerId: owners[index] ?? 'e1',
        lat: 55.7,
        lon: 37.6,
        startAt: 1000 + index * 1000 + delay,
        durationSec: 500,
      })),
    }),
  );
  assert.ok(result.main);
  return result.main;
}

function before(source: RouterPlan, origin = 'auto'): WorkingPlanForImpact {
  return {
    origin,
    assignments: source.assignments.map((row) => ({
      requestId: row.request_id,
      engineerId: row.engineer_id,
      status: row.status,
    })),
    routes: source.routes.map((route) => ({
      engineerId: route.engineer_id,
      stops: route.stops.map((stop) => ({
        kind: stop.kind,
        requestId: stop.request_id,
        startAt: stop.start_at,
        endAt: stop.end_at,
      })),
    })),
  };
}

function input(ids = ['a', 'b', 'c']): RouterTaskSnapshot {
  return {
    schema_version: '1.0',
    planning_as_of: 100,
    horizon_start_at: 100,
    horizon_end_at: 20000,
    engineers: [],
    policy: { policy_id: 'compact', parameters: {} },
    requests: ids.map((request_id, index) => ({
      request_id,
      region: 'east',
      arrival_order: index,
      location: { lat: 55.7, lon: 37.6 },
      service_duration_sec: 500,
      window_start_at: 100,
      window_end_at: 10000,
      priority: 'normal',
      required_skill: 'local',
      required_transport: null,
      required_equipment: null,
    })),
  };
}

describe('assisted plan consequences', () => {
  it('does not ask a second confirmation for one ordinary reassignment', () => {
    const impact = compareAssistedImpact(
      before(plan(['a', 'b', 'c'])),
      plan(['a', 'b', 'c'], ['e2', 'e1', 'e1']),
      input(),
    );
    assert.equal(impact.moved.length, 1);
    assert.equal(impact.requiresConfirmation, false);
  });

  it('requires confirmation before a previously assigned request loses its owner', () => {
    const impact = compareAssistedImpact(before(plan(['a', 'b', 'c'])), plan(['a', 'b']), input());
    assert.deepEqual(
      impact.lost.map((row) => row.requestId),
      ['c'],
    );
    assert.ok(impact.criticalReasons.some((row) => row.code === 'ASSIGNMENTS_LOST'));
  });

  it('does not count already executed/excluded work as a loss', () => {
    const impact = compareAssistedImpact(
      before(plan(['a', 'b', 'c'])),
      plan(['a', 'b']),
      input(['a', 'b']),
    );
    assert.equal(impact.requiresConfirmation, false);
  });

  it('detects mass reassignment, inversions, and a material delay', () => {
    const old = before(plan(['a', 'b', 'c']));
    assert.ok(
      compareAssistedImpact(
        old,
        plan(['a', 'b', 'c'], ['e2', 'e2', 'e2']),
        input(),
      ).criticalReasons.some((row) => row.code === 'MASS_REASSIGNMENT'),
    );
    assert.ok(
      compareAssistedImpact(old, plan(['c', 'b', 'a']), input()).criticalReasons.some(
        (row) => row.code === 'MASS_REORDER',
      ),
    );
    assert.ok(
      compareAssistedImpact(
        old,
        plan(['a', 'b', 'c'], undefined, 1800),
        input(),
      ).criticalReasons.some((row) => row.code === 'SIGNIFICANT_DELAY'),
    );
  });

  it('does not use an emergency manual schedule as verified timing evidence', () => {
    const impact = compareAssistedImpact(
      before(plan(['a', 'b', 'c']), 'manual'),
      plan(['a', 'b', 'c'], undefined, 6000),
      input(),
    );
    assert.equal(impact.timingsCompared, false);
    assert.equal(impact.delayed.length, 0);
  });

  it('refuses to reuse confirmation for a new loss or a larger critical delay bucket', () => {
    const old = before(plan(['a', 'b', 'c']));
    const approved = compareAssistedImpact(old, plan(['a', 'b']), input());
    assert.equal(criticalImpactCovered(approved, approved), true);
    assert.equal(
      criticalImpactCovered(approved, compareAssistedImpact(old, plan(['a']), input())),
      false,
    );
    const delayed = compareAssistedImpact(old, plan(['a', 'b', 'c'], undefined, 1800), input());
    assert.equal(
      criticalImpactCovered(
        delayed,
        compareAssistedImpact(old, plan(['a', 'b', 'c'], undefined, 2800), input()),
      ),
      false,
    );
  });
});
