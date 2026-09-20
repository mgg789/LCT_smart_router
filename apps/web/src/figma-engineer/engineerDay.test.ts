import { describe, expect, it } from 'vitest';
import type { EngineerDayView, EngineerPlanResponse, PlanStopView, RequestView } from '../api/types';
import { DESIGN_PREVIEW_DAY, DESIGN_PREVIEW_PLAN } from './designPreview';
import { engineerListItems, engineerLunchWindow, isOpenJob, missingRequestIds } from './engineerDay';

function stop(partial: Partial<PlanStopView> & Pick<PlanStopView, 'kind'>): PlanStopView {
  return {
    sequence: 1,
    requestId: null,
    lat: 55.75,
    lon: 37.62,
    arrivalAt: 100,
    startAt: 100,
    endAt: 200,
    ...partial,
  };
}

function request(partial: Partial<RequestView> & Pick<RequestView, 'id'>): RequestView {
  return {
    version: 1,
    lifecycle: 'submitted',
    assignmentState: 'assigned',
    addressText: 'ул. Таганская, 24',
    region: 'east',
    lat: 55.74,
    lon: 37.65,
    needsGeocoding: false,
    geocodeQuality: 'exact',
    requiredEquipment: null,
    workType: 'connection',
    workTypeTitle: 'Подключение офиса',
    requiredSkill: 'connection',
    normProfileCode: 'office',
    normativeTravelDurationSec: 600,
    technicalDurationSec: 1800,
    documentationDurationSec: 300,
    serviceDurationSec: 2700,
    actualDurationSec: null,
    durationVarianceSec: null,
    windowStartAt: 100,
    windowEndAt: 400,
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
    ...partial,
  };
}

function plan(stops: PlanStopView[], requests: RequestView[]): EngineerPlanResponse {
  return {
    planAsOf: 1,
    origin: 'auto',
    revision: 1,
    route: {
      engineerId: 'eng-1',
      startLat: 55.75,
      startLon: 37.62,
      startAt: 80,
      finishAt: 800,
      distanceKm: 12,
      travelTimeSec: 1200,
      workTimeSec: 3600,
      waitingTimeSec: 0,
      lunchTimeSec: 2700,
      assignedCount: requests.length,
      lunchStatus: 'planned',
      stops,
      legs: [],
    },
    requests,
  };
}

const day: EngineerDayView = {
  engineerId: 'eng-1',
  workDate: '2026-09-15',
  version: 1,
  shiftStartAt: 80,
  shiftEndAt: 800,
  availability: 'online',
  expectedOnlineAt: null,
  equipmentStock: { router: 1, setTopBox: 0, smartSpeaker: 0 },
  equipmentIssuedAt: null,
  lunch: {
    enabled: true,
    durationSec: 2700,
    windowStartAt: 500,
    windowEndAt: 650,
    required: false,
    taken: false,
    startedAt: null,
  },
};

describe('engineerDay', () => {
  it('marks the first open job as upcoming and keeps lunch in plan order', () => {
    const first = request({ id: 'req-1' });
    const second = request({ id: 'req-2', addressText: 'ул. Лесная, 7' });
    const items = engineerListItems(
      plan(
        [
          stop({ kind: 'job', requestId: 'req-1', sequence: 1, startAt: 120 }),
          stop({ kind: 'lunch', sequence: 2, startAt: 500, endAt: 650 }),
          stop({ kind: 'job', requestId: 'req-2', sequence: 3, startAt: 700 }),
        ],
        [first, second],
      ),
      day,
    );

    expect(items.map((item) => item.kind)).toEqual(['job', 'lunch', 'job']);
    expect(items[0]).toMatchObject({ kind: 'job', variant: 'upcoming', request: { id: 'req-1' } });
    expect(items[1]).toMatchObject({ kind: 'lunch', startAt: 500, endAt: 650 });
    expect(items[2]).toMatchObject({ kind: 'job', variant: 'regular', request: { id: 'req-2' } });
  });

  it('skips a finished first job when choosing the nearest card', () => {
    const done = request({
      id: 'req-done',
      lifecycle: 'completed',
      assignmentState: 'done',
    });
    const next = request({ id: 'req-next' });
    const items = engineerListItems(
      plan(
        [
          stop({ kind: 'job', requestId: 'req-done', sequence: 1 }),
          stop({ kind: 'job', requestId: 'req-next', sequence: 2 }),
        ],
        [done, next],
      ),
      { ...day, lunch: { ...day.lunch, enabled: false, windowStartAt: null, windowEndAt: null } },
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'job', variant: 'regular', request: { id: 'req-done' } });
    expect(items[1]).toMatchObject({ kind: 'job', variant: 'upcoming', request: { id: 'req-next' } });
  });

  it('appends the day lunch window when the route has no lunch stop', () => {
    const items = engineerListItems(
      plan([stop({ kind: 'job', requestId: 'req-1', sequence: 1 })], [request({ id: 'req-1' })]),
      day,
    );
    expect(items[1]).toMatchObject({ kind: 'lunch', startAt: 500, endAt: 650 });
    expect(engineerLunchWindow(plan([], []), day)).toEqual({
      kind: 'lunch',
      startAt: 500,
      endAt: 650,
    });
  });

  it('lists request ids that still need a fetch', () => {
    expect(
      missingRequestIds(
        plan([stop({ kind: 'job', requestId: 'req-missing', sequence: 1 })], [request({ id: 'req-1' })]),
      ),
    ).toEqual(['req-missing']);
  });

  it('treats cancelled jobs as closed', () => {
    expect(isOpenJob(request({ id: 'x', lifecycle: 'cancelled' }))).toBe(false);
  });

  it('builds the Figma sample as upcoming, lunch, then regular cards', () => {
    const items = engineerListItems(DESIGN_PREVIEW_PLAN, DESIGN_PREVIEW_DAY);
    expect(items.map((item) => (item.kind === 'job' ? item.variant : item.kind))).toEqual([
      'upcoming',
      'lunch',
      'regular',
      'regular',
    ]);
  });
});
