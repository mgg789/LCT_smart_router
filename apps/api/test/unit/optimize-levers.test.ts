import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogDeltaLines,
  countsImprove,
  describeCounts,
} from '../../src/orchestrator/ai/optimize-levers';
import type { SimulationCounts } from '../../src/routing/router-gateway';

function counts(partial: Partial<SimulationCounts>): SimulationCounts {
  return {
    assigned_count: 10,
    unassigned_count: 2,
    late_assigned_count: 1,
    total_lateness_sec: 100,
    distance_km: 20,
    ...partial,
  };
}

test('an improvement lowers open work or lateness and does not raise the other', () => {
  const before = counts({});
  assert.equal(countsImprove(before, counts({ unassigned_count: 1 })), true);
  assert.equal(countsImprove(before, counts({ late_assigned_count: 0, unassigned_count: 3 })), false);
  assert.equal(countsImprove(before, counts({ distance_km: 10 })), true);
  assert.equal(countsImprove(before, counts({ distance_km: 19.99 })), false);
});

test('catalog lines use the same before and after numbers as a lever', () => {
  const current = counts({});
  const better = counts({ unassigned_count: 0, late_assigned_count: 0 });
  const lines = catalogDeltaLines('balanced', [
    { strategy_id: 'balanced', metrics: current },
    { strategy_id: 'fast', metrics: better },
    { strategy_id: 'baseline', metrics: counts({ unassigned_count: 9 }) },
  ]);
  assert.deepEqual(lines, [`Политика «Быстрее»: ${describeCounts(current, better)}`]);
});
