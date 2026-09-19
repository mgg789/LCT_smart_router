import { describe, expect, it } from 'vitest';
import type { EngineerView } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { buildEngineerRows } from './engineerRows';

function engineer(id: string, name: string): EngineerView {
  return {
    id,
    version: 1,
    displayName: name,
    inputOrder: 0,
    skills: ['connection'],
    transportType: 'car',
    region: 'east',
    homeLat: 55.7,
    homeLon: 37.7,
    hasAccount: false,
    email: null,
    day: {
      engineerId: id,
      workDate: '2026-09-19',
      version: 1,
      shiftStartAt: 1_789_829_812,
      shiftEndAt: 1_789_873_012,
      availability: 'online',
      expectedOnlineAt: null,
      equipmentStock: {},
      equipmentIssuedAt: null,
      lunch: {
        enabled: false,
        durationSec: null,
        windowStartAt: null,
        windowEndAt: null,
        required: false,
        taken: false,
        startedAt: null,
      },
    },
  };
}

function request(id: string, lifecycle: RequestView['lifecycle']): RequestView {
  return {
    id,
    version: 1,
    lifecycle,
    assignmentState: 'assigned',
    addressText: 'Москва',
    region: 'east',
    lat: 55.7,
    lon: 37.7,
    needsGeocoding: false,
    geocodeQuality: null,
    workType: 'convergence',
    workTypeTitle: 'Конвергенция абонента',
    requiredSkill: 'connection',
    requiredEquipment: null,
    normProfileCode: null,
    normativeTravelDurationSec: null,
    technicalDurationSec: null,
    documentationDurationSec: null,
    serviceDurationSec: null,
    actualDurationSec: null,
    durationVarianceSec: null,
    windowStartAt: 1_789_865_812,
    windowEndAt: 1_789_873_012,
    priority: 'normal',
    contactName: null,
    problemText: null,
    createdAt: 1,
    submittedAt: 1,
    startedAt: null,
    expectedCompletionAt: null,
    continuationAvailableAt: null,
    overrunDetectedAt: null,
    completedAt: null,
    cancelledAt: null,
  };
}

const PLAN: PlanView = {
  revision: 1,
  origin: 'auto',
  planAsOf: 1_789_829_812,
  appliedAt: 1_789_829_900,
  routes: [
    {
      engineerId: 'e1',
      startLat: 55.7,
      startLon: 37.7,
      startAt: 1,
      finishAt: 2,
      distanceKm: 16.4,
      travelTimeSec: 3600,
      workTimeSec: 7200,
      waitingTimeSec: 0,
      lunchTimeSec: 0,
      assignedCount: 3,
      lunchStatus: 'not_scheduled',
      stops: [],
    },
  ],
  assignments: [
    { requestId: 'r1', status: 'assigned', engineerId: 'e1', reasons: [] },
    { requestId: 'r2', status: 'assigned', engineerId: 'e1', reasons: [] },
    { requestId: 'r3', status: 'assigned', engineerId: 'e1', reasons: [] },
    { requestId: 'r4', status: 'unassigned', engineerId: null, reasons: [] },
  ],
};

describe('buildEngineerRows', () => {
  it('counts progress from the requests, not from the plan', () => {
    const rows = buildEngineerRows([engineer('e1', 'Бригада Соколов')], PLAN, [
      request('r1', 'completed'),
      request('r2', 'completed'),
      request('r3', 'in_progress'),
    ]);

    expect(rows[0]).toMatchObject({ assignedCount: 3, doneCount: 2, distanceKm: 16.4 });
  });

  it('never blames a crew for an unassigned request', () => {
    const rows = buildEngineerRows([engineer('e1', 'Соколов')], PLAN, [request('r4', 'submitted')]);

    expect(rows[0]?.assignedCount).toBe(3);
    expect(rows[0]?.doneCount).toBe(0);
  });

  it('shows a crew with no route instead of hiding it', () => {
    const rows = buildEngineerRows([engineer('e9', 'Бригада Попов')], PLAN, []);

    expect(rows[0]).toMatchObject({ name: 'Бригада Попов', distanceKm: null, assignedCount: 0 });
  });

  it('survives a day with no applied plan at all', () => {
    const rows = buildEngineerRows([engineer('e1', 'Соколов')], null, [request('r1', 'completed')]);

    expect(rows[0]).toMatchObject({ distanceKm: null, assignedCount: 0, doneCount: 0 });
  });
});
