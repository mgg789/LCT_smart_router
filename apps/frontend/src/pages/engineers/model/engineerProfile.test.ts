import { describe, expect, it } from 'vitest';
import type { EngineerView } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { buildEngineerProfile, transportTitle } from './engineerProfile';

function engineer(over: Partial<EngineerView> = {}): EngineerView {
  return {
    id: 'e1',
    version: 1,
    displayName: 'Бригада Соколов',
    inputOrder: 0,
    skills: ['connection', 'emergency'],
    transportType: 'car',
    region: 'east',
    homeLat: 55.6998,
    homeLon: 37.7726,
    hasAccount: false,
    email: null,
    day: {
      engineerId: 'e1',
      workDate: '2026-09-19',
      version: 1,
      shiftStartAt: 1_000,
      shiftEndAt: 9_000,
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
    ...over,
  };
}

function request(id: string, lifecycle: RequestView['lifecycle'], address: string): RequestView {
  return {
    id,
    version: 1,
    lifecycle,
    assignmentState: 'assigned',
    addressText: address,
    region: 'east',
    lat: 55.7,
    lon: 37.7,
    needsGeocoding: false,
    geocodeQuality: null,
    workType: 'convergence',
    workTypeTitle: 'Конвергенция',
    requiredSkill: 'connection',
    requiredEquipment: null,
    normProfileCode: null,
    normativeTravelDurationSec: null,
    technicalDurationSec: null,
    documentationDurationSec: null,
    serviceDurationSec: null,
    actualDurationSec: null,
    durationVarianceSec: null,
    windowStartAt: 1,
    windowEndAt: 2,
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

const stop = (sequence: number, requestId: string | null, startAt: number, kind = 'job') => ({
  sequence,
  kind: kind as 'job' | 'lunch' | 'wait',
  requestId,
  lat: 55.7,
  lon: 37.7,
  arrivalAt: startAt,
  startAt,
  endAt: startAt + 100,
});

const PLAN: PlanView = {
  revision: 1,
  origin: 'auto',
  planAsOf: 1,
  appliedAt: 1,
  routes: [
    {
      engineerId: 'e1',
      startLat: 55.69,
      startLon: 37.77,
      startAt: 1,
      finishAt: 9_000,
      distanceKm: 16.4,
      travelTimeSec: 600,
      workTimeSec: 600,
      waitingTimeSec: 0,
      lunchTimeSec: 0,
      assignedCount: 3,
      lunchStatus: 'not_scheduled',
      stops: [stop(0, 'r1', 1_000), stop(1, 'r2', 2_000), stop(2, null, 3_000, 'wait')],
    },
  ],
  assignments: [
    { requestId: 'r1', status: 'assigned', engineerId: 'e1', reasons: [] },
    { requestId: 'r2', status: 'assigned', engineerId: 'e1', reasons: [] },
    { requestId: 'r3', status: 'assigned', engineerId: 'e2', reasons: [] },
  ],
};

const REQUESTS = [
  request('r1', 'completed', 'Москва, ул.Первая'),
  request('r2', 'in_progress', 'Москва, ул.Вторая'),
  request('r3', 'submitted', 'Москва, ул.Третья'),
];

describe('buildEngineerProfile', () => {
  it("counts only this crew's finished work", () => {
    const profile = buildEngineerProfile(engineer(), PLAN, REQUESTS);

    expect(profile.assignedCount).toBe(3);
    expect(profile.doneCount).toBe(1);
    expect(profile.distanceKm).toBe(16.4);
  });

  it('calls the stop under way the current one', () => {
    const profile = buildEngineerProfile(engineer(), PLAN, REQUESTS);

    expect(profile.current?.title).toBe('Москва, ул.Вторая');
    expect(profile.current?.running).toBe(true);
    expect(profile.nextStartAt).toBe(3_000);
  });

  it('names a stop with no request behind it instead of borrowing an address', () => {
    const profile = buildEngineerProfile(engineer(), PLAN, REQUESTS);

    expect(profile.stops[2]?.title).toBe('Ожидание');
  });

  it('falls back to the next unfinished stop when nothing is running', () => {
    const profile = buildEngineerProfile(engineer(), PLAN, [
      request('r1', 'completed', 'Москва, ул.Первая'),
      request('r2', 'submitted', 'Москва, ул.Вторая'),
    ]);

    expect(profile.current?.title).toBe('Москва, ул.Вторая');
    expect(profile.current?.running).toBe(false);
  });

  it('survives a crew with no route', () => {
    const profile = buildEngineerProfile(engineer({ id: 'e9' }), PLAN, REQUESTS);

    expect(profile.distanceKm).toBeNull();
    expect(profile.stops).toHaveLength(0);
    expect(profile.current).toBeNull();
  });
});

describe('transportTitle', () => {
  it('speaks Russian', () => {
    expect(transportTitle('car')).toBe('Легковой автомобиль');
    expect(transportTitle('transit')).toBe('Общественный транспорт');
  });
});
