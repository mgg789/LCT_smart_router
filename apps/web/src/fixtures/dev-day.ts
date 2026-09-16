import type {
  AlertView,
  AssignmentReasons,
  DashboardSnapshot,
  EngineerDayView,
  EngineerView,
  PlanAssignmentView,
  PlanRouteView,
  PlanStopView,
  PlanView,
  PolicySpec,
  RequestView,
} from '../api/types';
import { planWithLunches } from '../domain/dashboard';
import { moscowAt } from '../lib/time';

export const DEV_WORK_DATE = '2026-09-15';
const NOW = moscowAt(DEV_WORK_DATE, 11, 42);

const POLICIES: readonly PolicySpec[] = [
  {
    policyId: 'compact',
    title: 'Compact',
    description: 'Больше выполненных, затем меньше инженеров, затем пробег.',
    isDefault: true,
  },
  {
    policyId: 'fast',
    title: 'Fast',
    description: 'Сначала покрытие срочных, затем время в пути.',
    isDefault: false,
  },
  {
    policyId: 'sla',
    title: 'SLA safe',
    description: 'Покрытие, затем запас до конца окна.',
    isDefault: false,
  },
  {
    policyId: 'balanced',
    title: 'Balanced',
    description: 'Покрытие, затем ровная загрузка.',
    isDefault: false,
  },
  {
    policyId: 'eco',
    title: 'Eco',
    description: 'Покрытие, затем короткий пробег.',
    isDefault: false,
  },
];

interface Place {
  readonly id: string;
  readonly address: string;
  readonly lat: number;
  readonly lon: number;
  readonly title: string;
  readonly skill: string;
  readonly durationMin: number;
  readonly window: readonly [number, number];
  readonly priority?: 'normal' | 'urgent';
  readonly contact: string;
  readonly problem: string | null;
  readonly lifecycle?: RequestView['lifecycle'];
}

const PLACES: readonly Place[] = [
  {
    id: '10401',
    address: 'ул. Лесная, 7',
    lat: 55.7794,
    lon: 37.5891,
    title: 'Подключение офиса',
    skill: 'connection',
    durationMin: 40,
    window: [8, 12],
    contact: 'ООО Север',
    problem: 'Нужен канал 100 Мбит/с',
  },
  {
    id: '10408',
    address: 'ул. Покровка, 11',
    lat: 55.7608,
    lon: 37.6472,
    title: 'Подключение интернета',
    skill: 'connection',
    durationMin: 35,
    window: [9, 13],
    contact: 'Магазин «Проспект»',
    problem: null,
  },
  {
    id: '10422',
    address: 'Таганская, 24',
    lat: 55.7416,
    lon: 37.6533,
    title: 'Подключение офиса',
    skill: 'connection',
    durationMin: 45,
    window: [12, 14],
    contact: 'ООО «Горизонт»',
    problem: 'Подключить 100 Мбит/с, контактное лицо на ресепшене',
  },
  {
    id: '10427',
    address: 'ул. Земляной Вал, 50',
    lat: 55.7553,
    lon: 37.6565,
    title: 'Диагностика канала',
    skill: 'local',
    durationMin: 30,
    window: [13, 17],
    contact: 'Бизнес-центр «Вал»',
    problem: null,
  },
  {
    id: '10431',
    address: 'Пятницкая, 18',
    lat: 55.7436,
    lon: 37.6284,
    title: 'Замена ONU',
    skill: 'connection',
    durationMin: 25,
    window: [8, 11],
    contact: 'Кафе «Юг»',
    problem: null,
  },
  {
    id: '10433',
    address: 'Тверская, 7',
    lat: 55.7601,
    lon: 37.6094,
    title: 'Подключение интернета',
    skill: 'connection',
    durationMin: 40,
    window: [10, 14],
    contact: 'ООО Тверская',
    problem: null,
  },
  {
    id: '10436',
    address: 'Арбат, 12',
    lat: 55.751,
    lon: 37.593,
    title: 'Локальная сеть',
    skill: 'local',
    durationMin: 50,
    window: [11, 16],
    contact: 'Галерея Арбат',
    problem: null,
  },
  {
    id: '10438',
    address: 'Садовая-Кудринская, 9',
    lat: 55.7632,
    lon: 37.587,
    title: 'Подключение офиса',
    skill: 'connection',
    durationMin: 45,
    window: [9, 13],
    contact: 'ООО Кудринская',
    problem: null,
  },
  {
    id: '10441',
    address: 'Большая Ордынка, 25',
    lat: 55.7398,
    lon: 37.6236,
    title: 'Расширение порта',
    skill: 'local',
    durationMin: 30,
    window: [12, 16],
    contact: 'Ордынка 25',
    problem: null,
  },
  {
    id: '10444',
    address: 'Мясницкая, 13',
    lat: 55.7624,
    lon: 37.6339,
    title: 'Подключение интернета',
    skill: 'connection',
    durationMin: 35,
    window: [8, 12],
    contact: 'Студия Мясницкая',
    problem: null,
  },
  {
    id: '10447',
    address: 'Новый Арбат, 21',
    lat: 55.7533,
    lon: 37.5876,
    title: 'Сервисный визит',
    skill: 'local',
    durationMin: 20,
    window: [14, 17],
    contact: 'ТЦ Новый Арбат',
    problem: null,
  },
  {
    id: '10449',
    address: 'Сретенка, 8',
    lat: 55.7685,
    lon: 37.6312,
    title: 'Подключение офиса',
    skill: 'connection',
    durationMin: 40,
    window: [9, 12],
    contact: 'ООО Сретенка',
    problem: null,
  },
  {
    id: '10452',
    address: 'Полянка, 3',
    lat: 55.739,
    lon: 37.618,
    title: 'Диагностика Wi-Fi',
    skill: 'local',
    durationMin: 30,
    window: [11, 15],
    contact: 'Полянка 3',
    problem: null,
  },
  {
    id: '10455',
    address: 'Солянка, 14',
    lat: 55.7536,
    lon: 37.6388,
    title: 'Подключение интернета',
    skill: 'connection',
    durationMin: 35,
    window: [13, 17],
    contact: 'ООО Солянка',
    problem: null,
  },
  {
    id: '10458',
    address: 'Маросейка, 9',
    lat: 55.7578,
    lon: 37.638,
    title: 'Локальная сеть',
    skill: 'local',
    durationMin: 45,
    window: [10, 14],
    contact: 'Маросейка 9',
    problem: null,
  },
  {
    id: '10461',
    address: 'Остоженка, 16',
    lat: 55.741,
    lon: 37.598,
    title: 'Подключение офиса',
    skill: 'connection',
    durationMin: 40,
    window: [8, 12],
    contact: 'Остоженка 16',
    problem: null,
  },
  {
    id: '10464',
    address: 'Кузнецкий Мост, 6',
    lat: 55.7618,
    lon: 37.6205,
    title: 'Замена роутера',
    skill: 'connection',
    durationMin: 25,
    window: [12, 16],
    contact: 'Бутик КМ',
    problem: null,
  },
  {
    id: '10467',
    address: 'Чистопрудный бульвар, 5',
    lat: 55.7609,
    lon: 37.6389,
    title: 'Подключение интернета',
    skill: 'connection',
    durationMin: 30,
    window: [9, 13],
    contact: 'Чистые пруды',
    problem: null,
  },
  {
    id: '10470',
    address: 'Большая Никитская, 22',
    lat: 55.7574,
    lon: 37.5998,
    title: 'Сервисный визит',
    skill: 'local',
    durationMin: 20,
    window: [14, 17],
    contact: 'Никитская 22',
    problem: null,
  },
  {
    id: '10473',
    address: 'Якиманка, 10',
    lat: 55.7358,
    lon: 37.6145,
    title: 'Подключение офиса',
    skill: 'connection',
    durationMin: 45,
    window: [10, 15],
    contact: 'Якиманка 10',
    problem: null,
  },
  {
    id: '10476',
    address: 'Волхонка, 15',
    lat: 55.7466,
    lon: 37.6066,
    title: 'Диагностика канала',
    skill: 'local',
    durationMin: 30,
    window: [8, 11],
    contact: 'Волхонка 15',
    problem: null,
    lifecycle: 'completed',
  },
  {
    id: '10479',
    address: 'Петровка, 19',
    lat: 55.765,
    lon: 37.6155,
    title: 'Подключение интернета',
    skill: 'connection',
    durationMin: 35,
    window: [8, 12],
    contact: 'Петровка 19',
    problem: null,
    lifecycle: 'completed',
  },
  {
    id: '10490',
    address: 'Рождественка, 5',
    lat: 55.7629,
    lon: 37.6239,
    title: 'Видеонаблюдение, 8 камер',
    skill: 'video',
    durationMin: 90,
    window: [10, 16],
    priority: 'urgent',
    contact: 'ООО Контур',
    problem: 'Нужен инженер с навыком видеонаблюдения',
  },
  {
    id: '10491',
    address: 'Шаболовка, 31',
    lat: 55.7218,
    lon: 37.6112,
    title: 'Видеонаблюдение, склад',
    skill: 'video',
    durationMin: 80,
    window: [12, 17],
    contact: 'Склад Юг',
    problem: 'Нет инженера с навыком video',
  },
];

function toRequest(place: Place): RequestView {
  const lifecycle = place.lifecycle ?? 'submitted';
  const completed = lifecycle === 'completed';
  return {
    id: place.id,
    version: 1,
    lifecycle,
    assignmentState: completed ? 'done' : 'assigned',
    addressText: place.address,
    lat: place.lat,
    lon: place.lon,
    needsGeocoding: false,
    workType: place.skill,
    workTypeTitle: place.title,
    requiredSkill: place.skill,
    serviceDurationSec: place.durationMin * 60,
    windowStartAt: moscowAt(DEV_WORK_DATE, place.window[0]),
    windowEndAt: moscowAt(DEV_WORK_DATE, place.window[1]),
    priority: place.priority ?? 'normal',
    contactName: place.contact,
    problemText: place.problem,
    createdAt: moscowAt(DEV_WORK_DATE, 7, 10),
    submittedAt: moscowAt(DEV_WORK_DATE, 7, 12),
    startedAt: completed ? moscowAt(DEV_WORK_DATE, 8, 20) : null,
    completedAt: completed ? moscowAt(DEV_WORK_DATE, 9, 5) : null,
    cancelledAt: null,
  };
}

function markInProgress(request: RequestView): RequestView {
  return {
    ...request,
    lifecycle: 'in_progress',
    assignmentState: 'in_progress',
    startedAt: moscowAt(DEV_WORK_DATE, 10, 5),
  };
}

function markUnassigned(request: RequestView): RequestView {
  return { ...request, assignmentState: 'unassigned' };
}

function markDone(request: RequestView, startH: number, startM: number): RequestView {
  return {
    ...request,
    lifecycle: 'completed',
    assignmentState: 'done',
    startedAt: moscowAt(DEV_WORK_DATE, startH, startM),
    completedAt: moscowAt(DEV_WORK_DATE, startH, startM + 40),
  };
}

const REQUESTS_BASE = PLACES.map(toRequest);
const REQUESTS: RequestView[] = REQUESTS_BASE.map((request) => {
  if (
    request.id === '10401' ||
    request.id === '10408' ||
    request.id === '10476' ||
    request.id === '10479'
  ) {
    return markDone(request, request.id === '10408' ? 10 : 8, 10);
  }
  if (request.id === '10433') {
    return markInProgress(request);
  }
  if (request.id === '10490' || request.id === '10491') {
    return markUnassigned(request);
  }
  return request;
});

function engineer(
  id: string,
  name: string,
  order: number,
  skills: string[],
  home: readonly [number, number],
  lunchEnabled = false,
): EngineerView & { day: EngineerDayView } {
  return {
    id,
    version: 1,
    displayName: name,
    inputOrder: order,
    skills,
    transportType: 'car',
    region: 'moscow',
    homeLat: home[0],
    homeLon: home[1],
    hasAccount: true,
    day: {
      engineerId: id,
      workDate: DEV_WORK_DATE,
      version: 1,
      shiftStartAt: moscowAt(DEV_WORK_DATE, 8),
      shiftEndAt: moscowAt(DEV_WORK_DATE, 17),
      availability: 'online',
      expectedOnlineAt: null,
      lunch: {
        enabled: lunchEnabled,
        durationSec: lunchEnabled ? 30 * 60 : null,
        windowStartAt: lunchEnabled ? moscowAt(DEV_WORK_DATE, 11, 20) : null,
        windowEndAt: lunchEnabled ? moscowAt(DEV_WORK_DATE, 13, 0) : null,
        required: lunchEnabled,
        taken: false,
        startedAt: lunchEnabled ? moscowAt(DEV_WORK_DATE, 11, 25) : null,
      },
    },
  };
}

const ENGINEERS = [
  engineer('eng-sokolov', 'Алексей Соколов', 0, ['connection', 'local'], [55.75, 37.6]),
  engineer('eng-volkova', 'Елена Волкова', 1, ['connection', 'local'], [55.76, 37.62]),
  engineer('eng-alexandrov', 'Никита Александров', 2, ['connection'], [55.74, 37.61]),
  engineer('eng-petrov', 'Иван Петров', 3, ['local', 'connection'], [55.755, 37.64]),
];

function stop(
  sequence: number,
  requestId: string,
  arrivalH: number,
  arrivalM: number,
  workMin: number,
): PlanStopView {
  const place = PLACES.find((item) => item.id === requestId);
  if (!place) {
    throw new Error(`Unknown request ${requestId}`);
  }
  const arrivalAt = moscowAt(DEV_WORK_DATE, arrivalH, arrivalM);
  const startAt = arrivalAt + 2 * 60;
  return {
    sequence,
    kind: 'job',
    requestId,
    lat: place.lat,
    lon: place.lon,
    arrivalAt,
    startAt,
    endAt: startAt + workMin * 60,
  };
}

function route(
  engineerId: string,
  start: readonly [number, number],
  startAt: number,
  finishAt: number,
  distanceKm: number,
  stops: PlanStopView[],
): PlanRouteView {
  const travelTimeSec = Math.round(distanceKm * 180);
  const workTimeSec = stops.reduce((sum, item) => sum + (item.endAt - item.startAt), 0);
  return {
    engineerId,
    startLat: start[0],
    startLon: start[1],
    startAt,
    finishAt,
    distanceKm,
    travelTimeSec,
    workTimeSec,
    waitingTimeSec: 20 * 60,
    assignedCount: stops.filter((item) => item.kind === 'job').length,
    lunchStatus: stops.some((item) => item.kind === 'lunch') ? 'planned' : 'none',
    lunchTimeSec: stops
      .filter((item) => item.kind === 'lunch')
      .reduce((sum, item) => sum + (item.endAt - item.startAt), 0),
    stops,
  };
}

function lunchStop(
  sequence: number,
  hour: number,
  minute: number,
  durationMin: number,
  point: readonly [number, number],
): PlanStopView {
  const startAt = moscowAt(DEV_WORK_DATE, hour, minute);
  return {
    sequence,
    kind: 'lunch',
    requestId: null,
    lat: point[0],
    lon: point[1],
    arrivalAt: startAt,
    startAt,
    endAt: startAt + durationMin * 60,
  };
}

function reasons(chosen: string, travelMin: number, marginMin: number): AssignmentReasons {
  return {
    assignment: {
      chosen,
      factors: [
        { code: 'skill_match', ok: true, detail: 'Навык подключения офиса' },
        {
          code: 'equipment_ok',
          ok: true,
          detail: 'Есть требуемое оборудование (до 3,5 т)',
        },
        {
          code: 'sla_margin',
          ok: true,
          value: marginMin,
          detail: `Плановое начало входит в окно, запас ${marginMin} мин`,
        },
        {
          code: 'travel_delta',
          ok: true,
          value: travelMin,
          detail: `От предыдущей точки ехать ${travelMin} мин`,
        },
      ],
      alternatives: [
        {
          engineerId: 'eng-volkova',
          blocked: false,
          costDeltaMin: 18,
          whyNot: 'Навык есть, но +18 мин пути и запас окна падает до 6 мин',
        },
        {
          engineerId: 'eng-alexandrov',
          blocked: true,
          whyNot: 'Смена уже плотная, вставка срывает следующее окно',
        },
      ],
    },
  };
}

function unassignedReasons(skill: string): AssignmentReasons {
  return {
    assignment: {
      chosen: null,
      factors: [
        {
          code: 'skill_missing',
          ok: false,
          detail: `Нет инженера с навыком ${skill}`,
        },
      ],
      alternatives: ENGINEERS.map((item) => ({
        engineerId: item.id,
        blocked: true,
        whyNot: `В профиле нет навыка ${skill}`,
      })),
    },
  };
}

function assignment(
  requestId: string,
  engineerId: string | null,
  status: PlanAssignmentView['status'],
  extra?: AssignmentReasons,
): PlanAssignmentView {
  return {
    requestId,
    status,
    engineerId,
    reasons: extra ?? (engineerId ? reasons(engineerId, 12, 20) : unassignedReasons('video')),
  };
}

function buildAssignments(
  routes: PlanRouteView[],
  unassigned: readonly string[],
): PlanAssignmentView[] {
  const assigned = routes.flatMap((item) =>
    item.stops.flatMap((stop) => {
      if (!stop.requestId) {
        return [];
      }
      const request = REQUESTS.find((row) => row.id === stop.requestId);
      const status: PlanAssignmentView['status'] =
        request?.lifecycle === 'completed'
          ? 'done'
          : request?.lifecycle === 'in_progress'
            ? 'in_progress'
            : 'assigned';
      const extra = stop.requestId === '10422' ? reasons('eng-sokolov', 12, 20) : undefined;
      return [assignment(stop.requestId, item.engineerId, status, extra)];
    }),
  );
  return [...assigned, ...unassigned.map((id) => assignment(id, null, 'unassigned'))];
}

const CURRENT_ROUTES: PlanRouteView[] = [
  route(
    'eng-sokolov',
    [55.75, 37.6],
    moscowAt(DEV_WORK_DATE, 8, 20),
    moscowAt(DEV_WORK_DATE, 16, 10),
    28,
    [
      stop(1, '10401', 9, 10, 40),
      stop(2, '10408', 10, 13, 35),
      stop(3, '10422', 12, 0, 45),
      stop(4, '10427', 13, 20, 30),
      stop(5, '10447', 14, 40, 20),
      stop(6, '10470', 15, 30, 20),
    ],
  ),
  route(
    'eng-volkova',
    [55.76, 37.62],
    moscowAt(DEV_WORK_DATE, 8, 10),
    moscowAt(DEV_WORK_DATE, 16, 40),
    32,
    [
      stop(1, '10431', 8, 40, 25),
      stop(2, '10438', 9, 40, 45),
      stop(3, '10433', 11, 10, 40),
      stop(4, '10436', 12, 30, 50),
      stop(5, '10452', 14, 0, 30),
      stop(6, '10473', 15, 10, 45),
    ],
  ),
  route(
    'eng-alexandrov',
    [55.74, 37.61],
    moscowAt(DEV_WORK_DATE, 8, 15),
    moscowAt(DEV_WORK_DATE, 15, 50),
    24,
    [
      stop(1, '10461', 8, 50, 40),
      stop(2, '10444', 10, 0, 35),
      stop(3, '10449', 11, 10, 40),
      stop(4, '10464', 12, 40, 25),
      stop(5, '10441', 13, 40, 30),
    ],
  ),
  route(
    'eng-petrov',
    [55.755, 37.64],
    moscowAt(DEV_WORK_DATE, 8, 25),
    moscowAt(DEV_WORK_DATE, 16, 20),
    26,
    [
      stop(1, '10476', 8, 40, 30),
      stop(2, '10479', 9, 40, 35),
      stop(3, '10467', 10, 50, 30),
      lunchStop(4, 11, 25, 30, [55.761, 37.632]),
      stop(5, '10458', 12, 10, 45),
      stop(6, '10455', 13, 30, 35),
    ],
  ),
];

function planFrom(
  revision: number,
  asOfHour: number,
  asOfMin: number,
  routes: PlanRouteView[],
): PlanView {
  return {
    revision,
    origin: 'auto',
    planAsOf: moscowAt(DEV_WORK_DATE, asOfHour, asOfMin),
    appliedAt: moscowAt(DEV_WORK_DATE, asOfHour, asOfMin),
    routes,
    assignments: buildAssignments(routes, ['10490', '10491']),
  };
}

export const CURRENT_PLAN = planFrom(3, 11, 42, CURRENT_ROUTES);

const REBUILT_ROUTES: PlanRouteView[] = [
  route(
    'eng-sokolov',
    [55.75, 37.6],
    moscowAt(DEV_WORK_DATE, 8, 20),
    moscowAt(DEV_WORK_DATE, 16, 40),
    31,
    [
      stop(1, '10401', 9, 10, 40),
      stop(2, '10408', 10, 13, 35),
      stop(3, '10422', 12, 10, 45),
      stop(4, '10436', 13, 30, 50),
      stop(5, '10447', 15, 0, 20),
      stop(6, '10470', 15, 50, 20),
    ],
  ),
  route(
    'eng-volkova',
    [55.76, 37.62],
    moscowAt(DEV_WORK_DATE, 8, 10),
    moscowAt(DEV_WORK_DATE, 16, 10),
    27,
    [
      stop(1, '10431', 8, 40, 25),
      stop(2, '10438', 9, 40, 45),
      stop(3, '10433', 11, 10, 40),
      stop(4, '10452', 13, 0, 30),
      stop(5, '10473', 14, 10, 45),
    ],
  ),
  route(
    'eng-alexandrov',
    [55.74, 37.61],
    moscowAt(DEV_WORK_DATE, 8, 15),
    moscowAt(DEV_WORK_DATE, 15, 50),
    24,
    [
      stop(1, '10461', 8, 50, 40),
      stop(2, '10444', 10, 0, 35),
      stop(3, '10449', 11, 10, 40),
      stop(4, '10464', 12, 40, 25),
      stop(5, '10441', 13, 40, 30),
    ],
  ),
  route(
    'eng-petrov',
    [55.755, 37.64],
    moscowAt(DEV_WORK_DATE, 8, 25),
    moscowAt(DEV_WORK_DATE, 16, 40),
    29,
    [
      stop(1, '10476', 8, 40, 30),
      stop(2, '10479', 9, 40, 35),
      stop(3, '10467', 10, 50, 30),
      lunchStop(4, 11, 25, 30, [55.761, 37.632]),
      stop(5, '10458', 12, 10, 45),
      stop(6, '10427', 13, 20, 30),
      stop(7, '10455', 14, 20, 35),
    ],
  ),
];

export const REBUILT_PLAN = planFrom(4, 11, 44, REBUILT_ROUTES);

const ALERTS: AlertView[] = [
  {
    id: 'alert-video',
    code: 'UNASSIGNED_SKILL',
    severity: 'warning',
    engineerIds: [],
    requestIds: ['10490', '10491'],
    reasons: ['Нет инженера с навыком video'],
    restoreOption: null,
    createdAt: moscowAt(DEV_WORK_DATE, 11, 42),
    seenAt: null,
    resolvedAt: null,
  },
];

export function createDevSnapshot(plan: PlanView = CURRENT_PLAN): DashboardSnapshot {
  return {
    workDate: DEV_WORK_DATE,
    timeZone: 'Europe/Moscow',
    nowAt: NOW,
    policyId: 'compact',
    lunchesEnabled: false,
    policies: POLICIES,
    engineers: ENGINEERS,
    requests: REQUESTS,
    plan: {
      mode: 'auto',
      modeVersion: 1,
      plan: planWithLunches(plan, false),
      lastResult: {
        resultId: `res-${plan.revision}`,
        accepted: true,
        rejectionCode: null,
        receivedAt: plan.appliedAt,
      },
    },
    alerts: ALERTS,
  };
}

export const FOCUS_REQUEST_ID = '10422';
export const FOCUS_ENGINEER_ID = 'eng-sokolov';
