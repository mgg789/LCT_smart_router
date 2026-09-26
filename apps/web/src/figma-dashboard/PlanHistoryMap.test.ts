import { describe, expect, it } from 'vitest';
import type { DashboardSnapshot, PlanView } from '../api/types';
import { snapshotForPlanHistory } from './PlanHistoryMap';

const previous: PlanView = {
  revision: 142,
  origin: 'auto',
  planAsOf: 1,
  appliedAt: 1,
  routes: [],
  assignments: [],
};

const snapshot: DashboardSnapshot = {
  workDate: '2026-09-27',
  timeZone: 'Europe/Moscow',
  nowAt: 2,
  policyId: 'fast',
  lunchesEnabled: false,
  routerContextVersion: 'test',
  policies: [],
  engineers: [],
  requests: [],
  plan: {
    mode: 'auto',
    modeVersion: 1,
    plan: { ...previous, revision: 143 },
    appliedResult: null,
    lastResult: null,
  },
  alerts: [],
};

describe('plan history map snapshot', () => {
  it('switches the rendered map payload to the predecessor while choosing it', () => {
    expect(snapshotForPlanHistory(snapshot, previous, true, 'current')).toBe(snapshot);

    const historical = snapshotForPlanHistory(snapshot, previous, true, 'previous');
    expect(historical).not.toBe(snapshot);
    expect(historical.nowAt).toBe(previous.planAsOf);
    expect(historical.plan.plan).toBe(previous);
  });
});
