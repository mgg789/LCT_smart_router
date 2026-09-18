import type {
  EngineerDayView,
  EngineerPlanResponse,
  EngineerView,
  RequestView,
} from '../api/types';

/**
 * Offline preview of the Engineer App screens.
 *
 * Used when the device has no live session (`?demo=1`) so the pages can be reviewed
 * without the login-code contour.
 */
export function engineerDemoDay(nowAt: number = Math.floor(Date.now() / 1000)): {
  readonly profile: EngineerView;
  readonly day: EngineerDayView;
  readonly plan: EngineerPlanResponse;
} {
  const first: RequestView = {
    id: 'req-demo-1',
    version: 1,
    lifecycle: 'submitted',
    assignmentState: 'assigned',
    addressText: 'Москва, ул. Грайвороновская, д. 10 к. 2',
    region: 'east',
    lat: 55.7312,
    lon: 37.7284,
    needsGeocoding: false,
    geocodeQuality: 'address',
    requiredEquipment: 'router',
    workType: 'connection',
    workTypeTitle: 'Подключение',
    requiredSkill: 'connection',
    serviceDurationSec: 2400,
    windowStartAt: nowAt - 1800,
    windowEndAt: nowAt + 5400,
    priority: 'urgent',
    contactName: 'Анна Козлова',
    problemText: 'Не поднимается интернет после замены роутера',
    createdAt: nowAt - 20_000,
    submittedAt: nowAt - 18_000,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
  };
  const second: RequestView = {
    id: 'req-demo-2',
    version: 1,
    lifecycle: 'submitted',
    assignmentState: 'assigned',
    addressText: 'Москва, ул. Окская, д. 32',
    region: 'east',
    lat: 55.7168,
    lon: 37.7611,
    needsGeocoding: false,
    geocodeQuality: 'address',
    requiredEquipment: null,
    workType: 'local',
    workTypeTitle: 'Локальные работы',
    requiredSkill: 'local',
    serviceDurationSec: 1800,
    windowStartAt: nowAt + 7200,
    windowEndAt: nowAt + 14_400,
    priority: 'normal',
    contactName: 'Игорь Смирнов',
    problemText: 'Проверить ТВ-приставку и кабель',
    createdAt: nowAt - 12_000,
    submittedAt: nowAt - 11_000,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
  };

  return {
    profile: {
      id: 'eng-demo',
      version: 1,
      displayName: 'Иванов Иван Иванович',
      inputOrder: 1,
      skills: ['connection', 'local'],
      transportType: 'car',
      region: 'east',
      homeLat: 55.74,
      homeLon: 37.72,
      hasAccount: true,
      email: 'brigade1@example.test',
    },
    day: {
      engineerId: 'eng-demo',
      workDate: '2026-09-18',
      version: 1,
      shiftStartAt: nowAt - 3600,
      shiftEndAt: nowAt + 28_800,
      availability: 'online',
      expectedOnlineAt: null,
      equipmentStock: { router: 2, setTopBox: 1, smartSpeaker: 0 },
      equipmentIssuedAt: nowAt - 3600,
      lunch: {
        enabled: true,
        durationSec: 3600,
        windowStartAt: nowAt + 5400,
        windowEndAt: nowAt + 10_800,
        required: true,
        taken: false,
        startedAt: null,
      },
    },
    plan: {
      planAsOf: nowAt,
      origin: 'auto',
      revision: 3,
      requests: [first, second],
      route: {
        engineerId: 'eng-demo',
        startLat: 55.74,
        startLon: 37.72,
        startAt: nowAt - 900,
        finishAt: nowAt + 16_200,
        distanceKm: 11.4,
        travelTimeSec: 2100,
        workTimeSec: 4200,
        waitingTimeSec: 300,
        lunchTimeSec: 3600,
        assignedCount: 2,
        lunchStatus: 'scheduled',
        stops: [
          {
            sequence: 1,
            kind: 'job',
            requestId: first.id,
            lat: first.lat ?? 55.7312,
            lon: first.lon ?? 37.7284,
            arrivalAt: nowAt - 300,
            startAt: nowAt,
            endAt: nowAt + 2400,
          },
          {
            sequence: 2,
            kind: 'lunch',
            requestId: null,
            lat: 55.724,
            lon: 37.745,
            arrivalAt: nowAt + 5400,
            startAt: nowAt + 5400,
            endAt: nowAt + 9000,
          },
          {
            sequence: 3,
            kind: 'job',
            requestId: second.id,
            lat: second.lat ?? 55.7168,
            lon: second.lon ?? 37.7611,
            arrivalAt: nowAt + 9600,
            startAt: nowAt + 9900,
            endAt: nowAt + 11_700,
          },
        ],
        legs: [
          {
            legId: 'leg-1',
            fromStopId: null,
            toStopId: '1',
            departureAt: nowAt - 900,
            arrivalAt: nowAt - 300,
            travelTimeSec: 600,
            distanceKm: 3.1,
            travelSource: 'road_matrix',
            trafficFactor: 1,
            geometry: {
              points: [
                { lat: 55.74, lon: 37.72 },
                { lat: 55.7312, lon: 37.7284 },
              ],
            },
          },
          {
            legId: 'leg-2',
            fromStopId: '1',
            toStopId: '2',
            departureAt: nowAt + 2400,
            arrivalAt: nowAt + 5400,
            travelTimeSec: 800,
            distanceKm: 4.2,
            travelSource: 'road_matrix',
            trafficFactor: 1,
            geometry: {
              points: [
                { lat: 55.7312, lon: 37.7284 },
                { lat: 55.724, lon: 37.745 },
              ],
            },
          },
          {
            legId: 'leg-3',
            fromStopId: '2',
            toStopId: '3',
            departureAt: nowAt + 9000,
            arrivalAt: nowAt + 9600,
            travelTimeSec: 600,
            distanceKm: 4.1,
            travelSource: 'road_matrix',
            trafficFactor: 1,
            geometry: {
              points: [
                { lat: 55.724, lon: 37.745 },
                { lat: 55.7168, lon: 37.7611 },
              ],
            },
          },
        ],
      },
    },
  };
}

/** True when the Engineer App was opened as an offline preview. */
export function isEngineerDemo(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('demo') === '1';
}
