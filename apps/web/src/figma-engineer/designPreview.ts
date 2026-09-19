import type { EngineerDayView, EngineerPlanResponse, EngineerView, PlanStopView, RequestView } from '../api/types';
import { moscowAt } from '../lib/time';

const WORK_DATE = '2026-09-15';

function stop(
  partial: Pick<PlanStopView, 'sequence' | 'kind' | 'startAt' | 'endAt'> &
    Partial<Pick<PlanStopView, 'requestId'>>,
): PlanStopView {
  return {
    requestId: null,
    lat: 55.74,
    lon: 37.65,
    arrivalAt: partial.startAt,
    ...partial,
  };
}

function request(partial: Pick<RequestView, 'id' | 'addressText' | 'workTypeTitle' | 'serviceDurationSec' | 'windowStartAt' | 'windowEndAt'>): RequestView {
  return {
    version: 1,
    lifecycle: 'submitted',
    assignmentState: 'assigned',
    region: 'east',
    lat: 55.74,
    lon: 37.65,
    needsGeocoding: false,
    geocodeQuality: 'exact',
    requiredEquipment: null,
    workType: 'connection',
    requiredSkill: 'connection',
    priority: 'normal',
    contactName: null,
    problemText: null,
    createdAt: moscowAt(WORK_DATE, 8, 0),
    submittedAt: moscowAt(WORK_DATE, 8, 0),
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...partial,
  };
}

/** Frozen «now» so the request screen shows Figma «Через 25 минут». */
export const DESIGN_PREVIEW_NOW_MS = moscowAt(WORK_DATE, 11, 55) * 1000;

/** Figma MAIN 73:9536 sample — DEV `?design=1` only, never a live plan. */
export const DESIGN_PREVIEW_PROFILE: EngineerView = {
  id: 'eng-preview',
  version: 1,
  displayName: 'Александра Смирнова',
  inputOrder: 1,
  skills: ['connection'],
  transportType: 'car',
  region: 'east',
  homeLat: 55.75,
  homeLon: 37.62,
  hasAccount: true,
  email: 'alexandrasmirnova@gmail.com',
};

export const DESIGN_PREVIEW_DAY: EngineerDayView = {
  engineerId: 'eng-preview',
  workDate: WORK_DATE,
  version: 1,
  shiftStartAt: moscowAt(WORK_DATE, 8, 0),
  shiftEndAt: moscowAt(WORK_DATE, 17, 0),
  availability: 'online',
  expectedOnlineAt: null,
  equipmentStock: { router: 1, setTopBox: 0, smartSpeaker: 0 },
  equipmentIssuedAt: null,
  lunch: {
    enabled: true,
    durationSec: 45 * 60,
    windowStartAt: moscowAt(WORK_DATE, 13, 30),
    windowEndAt: moscowAt(WORK_DATE, 14, 15),
    required: false,
    taken: false,
    startedAt: null,
  },
};

export const DESIGN_PREVIEW_PLAN: EngineerPlanResponse = {
  planAsOf: moscowAt(WORK_DATE, 8, 0),
  origin: 'auto',
  revision: 1,
  route: {
    engineerId: 'eng-preview',
    startLat: 55.75,
    startLon: 37.62,
    startAt: moscowAt(WORK_DATE, 8, 0),
    finishAt: moscowAt(WORK_DATE, 17, 0),
    distanceKm: 18,
    travelTimeSec: 2400,
    workTimeSec: 7200,
    waitingTimeSec: 0,
    lunchTimeSec: 2700,
    assignedCount: 3,
    lunchStatus: 'planned',
    stops: [
      stop({
        sequence: 1,
        kind: 'job',
        requestId: 'req-taganka',
        startAt: moscowAt(WORK_DATE, 12, 20),
        endAt: moscowAt(WORK_DATE, 13, 5),
      }),
      stop({
        sequence: 2,
        kind: 'lunch',
        startAt: moscowAt(WORK_DATE, 13, 30),
        endAt: moscowAt(WORK_DATE, 14, 15),
      }),
      stop({
        sequence: 3,
        kind: 'job',
        requestId: 'req-lesnaya-a',
        startAt: moscowAt(WORK_DATE, 9, 17),
        endAt: moscowAt(WORK_DATE, 10, 20),
      }),
      stop({
        sequence: 4,
        kind: 'job',
        requestId: 'req-lesnaya-b',
        startAt: moscowAt(WORK_DATE, 9, 17),
        endAt: moscowAt(WORK_DATE, 10, 20),
      }),
    ],
    legs: [],
  },
  requests: [
    {
      ...request({
        id: 'req-taganka',
        addressText: 'ул. Таганская, дом 17, корп. 1, этаж 4, кв. 14',
        workTypeTitle: 'Подключение интернета',
        serviceDurationSec: 45 * 60,
        windowStartAt: moscowAt(WORK_DATE, 12, 0),
        windowEndAt: moscowAt(WORK_DATE, 14, 0),
      }),
      contactName: 'Виктор Сергеевич Кравцов',
      requiredEquipment: 'router',
    },
    request({
      id: 'req-lesnaya-a',
      addressText: 'Офис - ул. Лесная, 7',
      workTypeTitle: 'Замена роутера',
      serviceDurationSec: 40 * 60,
      windowStartAt: moscowAt(WORK_DATE, 9, 0),
      windowEndAt: moscowAt(WORK_DATE, 10, 20),
    }),
    request({
      id: 'req-lesnaya-b',
      addressText: 'Офис - ул. Лесная, 7',
      workTypeTitle: 'Замена роутера',
      serviceDurationSec: 40 * 60,
      windowStartAt: moscowAt(WORK_DATE, 9, 0),
      windowEndAt: moscowAt(WORK_DATE, 10, 20),
    }),
  ],
};

/** True only in the local Vite app when the URL asks for the Figma sample. */
export function isEngineerDesignPreview(): boolean {
  if (!import.meta.env.DEV) return false;
  return new URLSearchParams(window.location.search).has('design');
}
