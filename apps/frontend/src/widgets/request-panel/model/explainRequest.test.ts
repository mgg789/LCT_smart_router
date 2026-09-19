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
  it('states the demand, the crew and the slack in the window', () => {
    const assignment: PlanAssignmentView = {
      requestId: 'r1',
      status: 'assigned',
      engineerId: 'e1',
      reasons: [{ code: 'CONSTRAINTS_SATISFIED', text: 'ok', basis: 'constraint_check' }],
    };

    const explanation = explainRequest(REQUEST, assignment, ENGINEER, ROUTE, [ENGINEER]);

    expect(explanation.title).toBe('Почему Бригада Соколов?');
    expect(explanation.facts[0]).toContain('навык «Подключение»');
    expect(explanation.facts[1]).toContain('Легковой автомобиль');
    expect(explanation.facts[2]).toContain('первая работа');
    expect(explanation.facts[3]).toContain('запас до конца окна');
    expect(explanation.result).toBe('Заявка назначена: Бригада Соколов.');
    expect(explanation.fromSearchOnly).toBe(false);
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
    expect(explanation.influence).toContain('не доказательство невозможности');
  });

  it('counts the crews of the region that could have taken it', () => {
    const explanation = explainRequest(
      { ...REQUEST, assignmentState: 'unassigned' },
      { requestId: 'r1', status: 'unassigned', engineerId: null, reasons: [] },
      null,
      null,
      [ENGINEER, { ...ENGINEER, id: 'e2', skills: ['local'] } as EngineerView],
    );

    expect(explanation.facts[1]).toContain('2 бригад');
    expect(explanation.facts[1]).toContain('1 с нужным навыком');
  });

  it('says plainly when the solver sent no reasons at all', () => {
    const explanation = explainRequest(
      { ...REQUEST, assignmentState: 'unassigned' },
      { requestId: 'r1', status: 'unassigned', engineerId: null, reasons: [] },
      null,
      null,
      [ENGINEER],
    );

    expect(explanation.facts[2]).toContain('не прислал причин');
    expect(explanation.fromSearchOnly).toBe(false);
  });
});
