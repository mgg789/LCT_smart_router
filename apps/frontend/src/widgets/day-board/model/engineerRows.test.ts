import { describe, expect, it } from 'vitest';
import type { EngineerView } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';
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
  it('reports the work still ahead of the crew', () => {
    const rows = buildEngineerRows([engineer('e1', 'Бригада Соколов')], PLAN);

    expect(rows[0]).toMatchObject({ assignedCount: 3, distanceKm: 16.4 });
  });

  it('never counts an unassigned request against a crew', () => {
    const rows = buildEngineerRows([engineer('e1', 'Соколов')], PLAN);

    expect(rows[0]?.assignedCount).toBe(3);
  });

  it('shows a crew with no route instead of hiding it', () => {
    const rows = buildEngineerRows([engineer('e9', 'Бригада Попов')], PLAN);

    expect(rows[0]).toMatchObject({ name: 'Бригада Попов', distanceKm: null, assignedCount: 0 });
  });

  it('survives a day with no applied plan at all', () => {
    const rows = buildEngineerRows([engineer('e1', 'Соколов')], null);

    expect(rows[0]).toMatchObject({ distanceKm: null, assignedCount: 0 });
  });

  it('carries the shift so the card can show it', () => {
    const rows = buildEngineerRows([engineer('e1', 'Соколов')], PLAN);

    expect(rows[0]?.shiftStartAt).toBe(1_789_829_812);
    expect(rows[0]?.availability).toBe('online');
  });
});
