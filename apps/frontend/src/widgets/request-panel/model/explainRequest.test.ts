import { describe, expect, it } from 'vitest';
import type { EngineerView } from '@/entities/engineer';
import type { PlanAssignmentView, PlanRouteView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { explainRequest } from './explainRequest';

const REQUEST: RequestView = {
  id: 'r1',
  version: 1,
  lifecycle: 'submitted',
  assignmentState: 'assigned',
  addressText: 'Москва, ул.Садовники, д. 10',
  region: 'south_central',
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
  serviceDurationSec: 4200,
  actualDurationSec: null,
  durationVarianceSec: null,
  windowStartAt: 10_000,
  windowEndAt: 20_000,
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

const ENGINEER = {
  id: 'e1',
  displayName: 'Бригада Соколов',
  skills: ['connection'],
  transportType: 'car',
  region: 'south_central',
  day: { availability: 'online' },
} as unknown as EngineerView;

const ROUTE = {
  engineerId: 'e1',
  startLat: 55.6,
  startLon: 37.6,
  startAt: 1,
  finishAt: 2,
  distanceKm: 5,
  travelTimeSec: 600,
  workTimeSec: 600,
  waitingTimeSec: 0,
  lunchTimeSec: 0,
  assignedCount: 2,
  lunchStatus: 'not_scheduled',
  stops: [
    {
      sequence: 0,
      kind: 'job',
      requestId: 'r1',
      lat: 55.7,
      lon: 37.7,
      arrivalAt: 11_000,
      startAt: 11_000,
      endAt: 15_000,
    },
  ],
} as PlanRouteView;

describe('explainRequest', () => {
  it('states the demand and the slack in the window, in short lines', () => {
    const assignment: PlanAssignmentView = {
      requestId: 'r1',
      status: 'assigned',
      engineerId: 'e1',
      reasons: [{ code: 'CONSTRAINTS_SATISFIED', text: 'ok', basis: 'constraint_check' }],
    };

    const explanation = explainRequest(REQUEST, assignment, ENGINEER, ROUTE, [ENGINEER]);

    expect(explanation.title).toBe('Почему эта бригада?');
    expect(explanation.points).toContain('Навык: Подключение');
    expect(explanation.points).toContain('Первая работа после старта смены');
    expect(explanation.points).toContain('Запас до конца окна: 150 мин');
    expect(explanation.points).toContain('Ограничения выполнены');
    expect(explanation.fromSearchOnly).toBe(false);
    expect(explanation.note).toBeNull();
  });

  it('names no crew: the panel answers on what grounds, not who', () => {
    const assignment: PlanAssignmentView = {
      requestId: 'r1',
      status: 'assigned',
      engineerId: 'e1',
      reasons: [],
    };

    const explanation = explainRequest(REQUEST, assignment, ENGINEER, ROUTE, [ENGINEER]);

    const text = [explanation.title, ...explanation.points].join(' ');
    expect(text).not.toContain('Соколов');
  });

  it('keeps every line short enough to read at a glance', () => {
    const assignment: PlanAssignmentView = {
      requestId: 'r1',
      status: 'assigned',
      engineerId: 'e1',
      reasons: [{ code: 'skill_match', text: 'ok', basis: 'constraint_check' }],
    };

    const explanation = explainRequest(REQUEST, assignment, ENGINEER, ROUTE, [ENGINEER]);

    for (const point of explanation.points) expect(point.length).toBeLessThanOrEqual(46);
  });

  it('refuses to call a limited search a proof', () => {
    const assignment: PlanAssignmentView = {
      requestId: 'r1',
      status: 'unassigned',
      engineerId: null,
      reasons: [
        {
          code: 'NO_FEASIBLE_ASSIGNMENT_FOUND',
          text: 'not found',
          basis: 'calculation_outcome',
        },
      ],
    };

    const explanation = explainRequest(
      { ...REQUEST, assignmentState: 'unassigned' },
      assignment,
      null,
      null,
      [ENGINEER],
    );

    expect(explanation.title).toBe('Почему без назначения?');
    expect(explanation.fromSearchOnly).toBe(true);
    expect(explanation.note).toContain('не доказательство');
  });

  it('counts the crews of the region that could have taken it', () => {
    const explanation = explainRequest(
      { ...REQUEST, assignmentState: 'unassigned' },
      { requestId: 'r1', status: 'unassigned', engineerId: null, reasons: [] },
      null,
      null,
      [ENGINEER, { ...ENGINEER, id: 'e2', skills: ['local'] } as EngineerView],
    );

    expect(explanation.points).toContain('Бригад в регионе: 2');
    expect(explanation.points).toContain('С нужным навыком: 1');
  });

  it('says plainly when the solver sent no reasons at all', () => {
    const explanation = explainRequest(
      { ...REQUEST, assignmentState: 'unassigned' },
      { requestId: 'r1', status: 'unassigned', engineerId: null, reasons: [] },
      null,
      null,
      [ENGINEER],
    );

    expect(explanation.points).toContain('Решатель не прислал причин');
    expect(explanation.fromSearchOnly).toBe(false);
  });
});
