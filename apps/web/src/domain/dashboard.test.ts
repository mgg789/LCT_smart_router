import { describe, expect, it } from 'vitest';
import {
  CURRENT_PLAN,
  createDevSnapshot,
  FOCUS_REQUEST_ID,
  REBUILT_PLAN,
} from '../fixtures/dev-day';
import {
  computePlanDelta,
  engineerSummaries,
  plannedActivity,
  planWithLunches,
  requestById,
  routeVertices,
  unassignedRequests,
  withLunches,
} from './dashboard';

describe('dev dashboard fixture', () => {
  it('keeps two skill-blocked requests unassigned', () => {
    const snapshot = createDevSnapshot();
    const unassigned = unassignedRequests(snapshot);
    expect(unassigned.map((item) => item.id)).toEqual(['10490', '10491']);
    expect(snapshot.requests).toHaveLength(24);
  });

  it('summarizes Sokolov route from the applied plan', () => {
    const [sokolov] = engineerSummaries(createDevSnapshot());
    expect(sokolov?.engineerId).toBe('eng-sokolov');
    expect(sokolov?.assignedCount).toBe(6);
    expect(sokolov?.distanceKm).toBe(28);
  });

  it('exposes structured reasons for the focused request', () => {
    const snapshot = createDevSnapshot();
    const request = requestById(snapshot, FOCUS_REQUEST_ID);
    const assignment = snapshot.plan.plan?.assignments.find(
      (item) => item.requestId === FOCUS_REQUEST_ID,
    );
    expect(request?.addressText).toContain('Таганская');
    expect(assignment?.engineerId).toBe('eng-sokolov');
    expect(assignment?.reasons.assignment?.factors[0]?.code).toBe('skill_match');
  });

  it('starts every route at a named depot, not at the first job', () => {
    const snapshot = createDevSnapshot();
    const route = snapshot.plan.plan?.routes[0];
    expect(route).toBeTruthy();
    if (!route) {
      return;
    }
    const [start, firstJob] = routeVertices(route);
    expect(start?.kind).toBe('start');
    expect(start?.lat).toBe(route.startLat);
    expect(firstJob?.kind).toBe('job');
  });

  it('reads planned activity at 11:42 without inventing GPS', () => {
    const snapshot = createDevSnapshot();
    const traveling = plannedActivity(snapshot, 'eng-sokolov');
    expect(traveling?.kind).toBe('traveling');
    expect(traveling?.lat).toBeNull();
    expect(traveling?.lon).toBeNull();
    expect(traveling?.legIndex).toBeTypeOf('number');
    expect(plannedActivity(snapshot, 'eng-volkova')?.kind).toBe('on_site');
    expect(snapshot.lunchesEnabled).toBe(false);
    expect(plannedActivity(snapshot, 'eng-petrov')?.kind).toBe('traveling');
  });

  it('places Petrov lunch only after the dashboard switch is on', () => {
    const off = createDevSnapshot();
    expect(off.engineers.every((item) => item.day?.lunch.enabled === false)).toBe(true);
    expect(off.plan.plan?.routes.some((route) => route.lunchStatus !== 'none')).toBe(false);

    const on = withLunches(
      { ...off, plan: { ...off.plan, plan: planWithLunches(CURRENT_PLAN, true) } },
      true,
    );
    expect(on.lunchesEnabled).toBe(true);
    expect(on.engineers.every((item) => item.day?.lunch.enabled === true)).toBe(true);
    expect(plannedActivity(on, 'eng-petrov')?.kind).toBe('lunch');
  });

  it('computes a readable replan delta between fixture plans', () => {
    const delta = computePlanDelta(CURRENT_PLAN, REBUILT_PLAN, 1180);
    expect(delta.transferred).toBeGreaterThan(0);
    expect(delta.shifted).toBeGreaterThan(0);
    expect(delta.slaBefore).toBe(2);
    expect(delta.slaAfter).toBe(2);
    expect(delta.solveMs).toBe(1180);
  });
});
