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
import { t } from '../i18n';
import { moscowAt } from '../lib/time';

export const DEV_WORK_DATE = '2026-09-15';
const NOW = moscowAt(DEV_WORK_DATE, 11, 42);

const POLICIES: readonly PolicySpec[] = [
  {
    policyId: 'compact',
    title: t('fixtures.dev-day.99452646e3'),
    description: t('fixtures.dev-day.5d159caee6'),
    isDefault: true,
  },
  {
    policyId: 'fast',
    title: t('fixtures.dev-day.6c582b62e0'),
    description: t('fixtures.dev-day.2e7193b93a'),
    isDefault: false,
  },
  {
    policyId: 'sla',
    title: t('fixtures.dev-day.ff2cd3df11'),
    description: t('fixtures.dev-day.d2a9b10c9e'),
    isDefault: false,
  },
  {
    policyId: 'balanced',
    title: t('fixtures.dev-day.5386ea5db8'),
    description: t('fixtures.dev-day.586da3d505'),
    isDefault: false,
  },
  {
    policyId: 'eco',
    title: t('fixtures.dev-day.330a4e5fcb'),
    description: t('fixtures.dev-day.4690e44c2b'),
    isDefault: false,
  },
  {
    policyId: 'covering',
    title: t('fixtures.dev-day.6a1fe69174'),
    description: t('fixtures.dev-day.4d269843ff'),
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
    address: t('fixtures.dev-day.f388e5e908'),
    lat: 55.7794,
    lon: 37.5891,
    title: t('fixtures.dev-day.267805bd26'),
    skill: 'connection',
    durationMin: 40,
    window: [8, 12],
    contact: t('fixtures.dev-day.31b15fa695'),
    problem: t('fixtures.dev-day.472b30b3e9'),
  },
  {
    id: '10408',
    address: t('fixtures.dev-day.dec4e8528d'),
    lat: 55.7608,
    lon: 37.6472,
    title: t('fixtures.dev-day.9fa84e238b'),
    skill: 'connection',
    durationMin: 35,
    window: [9, 13],
    contact: t('fixtures.dev-day.b812ee57a9'),
    problem: null,
  },
  {
    id: '10422',
    address: t('fixtures.dev-day.d0ddab524d'),
    lat: 55.7416,
    lon: 37.6533,
    title: t('fixtures.dev-day.267805bd26'),
    skill: 'connection',
    durationMin: 45,
    window: [12, 14],
    contact: t('fixtures.dev-day.2e303730cf'),
    problem: t('fixtures.dev-day.6543cd0668'),
  },
  {
    id: '10427',
    address: t('fixtures.dev-day.ffee260c65'),
    lat: 55.7553,
    lon: 37.6565,
    title: t('fixtures.dev-day.ce012f2374'),
    skill: 'local',
    durationMin: 30,
    window: [13, 17],
    contact: t('fixtures.dev-day.e478563945'),
    problem: null,
  },
  {
    id: '10431',
    address: t('fixtures.dev-day.d2b0e87e6d'),
    lat: 55.7436,
    lon: 37.6284,
    title: t('fixtures.dev-day.0a163c10a2'),
    skill: 'connection',
    durationMin: 25,
    window: [8, 11],
    contact: t('fixtures.dev-day.4f4f8a9f14'),
    problem: null,
  },
  {
    id: '10433',
    address: t('fixtures.dev-day.bd91acf11c'),
    lat: 55.7601,
    lon: 37.6094,
    title: t('fixtures.dev-day.9fa84e238b'),
    skill: 'connection',
    durationMin: 40,
    window: [10, 14],
    contact: t('fixtures.dev-day.4b1126bf6d'),
    problem: null,
  },
  {
    id: '10436',
    address: t('fixtures.dev-day.2c3150614e'),
    lat: 55.751,
    lon: 37.593,
    title: t('fixtures.dev-day.7de9e2be0d'),
    skill: 'local',
    durationMin: 50,
    window: [11, 16],
    contact: t('fixtures.dev-day.c690d7026f'),
    problem: null,
  },
  {
    id: '10438',
    address: t('fixtures.dev-day.57d55077a8'),
    lat: 55.7632,
    lon: 37.587,
    title: t('fixtures.dev-day.267805bd26'),
    skill: 'connection',
    durationMin: 45,
    window: [9, 13],
    contact: t('fixtures.dev-day.9a62d3ec43'),
    problem: null,
  },
  {
    id: '10441',
    address: t('fixtures.dev-day.96258469e4'),
    lat: 55.7398,
    lon: 37.6236,
    title: t('fixtures.dev-day.cbf56fd7b0'),
    skill: 'local',
    durationMin: 30,
    window: [12, 16],
    contact: t('fixtures.dev-day.5f7e0e5abe'),
    problem: null,
  },
  {
    id: '10444',
    address: t('fixtures.dev-day.436e87454e'),
    lat: 55.7624,
    lon: 37.6339,
    title: t('fixtures.dev-day.9fa84e238b'),
    skill: 'connection',
    durationMin: 35,
    window: [8, 12],
    contact: t('fixtures.dev-day.094702dd63'),
    problem: null,
  },
  {
    id: '10447',
    address: t('fixtures.dev-day.d09847bf80'),
    lat: 55.7533,
    lon: 37.5876,
    title: t('fixtures.dev-day.e887da99bb'),
    skill: 'local',
    durationMin: 20,
    window: [14, 17],
    contact: t('fixtures.dev-day.5bdcdb7a83'),
    problem: null,
  },
  {
    id: '10449',
    address: t('fixtures.dev-day.4d5abcbe47'),
    lat: 55.7685,
    lon: 37.6312,
    title: t('fixtures.dev-day.267805bd26'),
    skill: 'connection',
    durationMin: 40,
    window: [9, 12],
    contact: t('fixtures.dev-day.de6c2c6874'),
    problem: null,
  },
  {
    id: '10452',
    address: t('fixtures.dev-day.4e83cd160a'),
    lat: 55.739,
    lon: 37.618,
    title: t('fixtures.dev-day.fb5babb54c'),
    skill: 'local',
    durationMin: 30,
    window: [11, 15],
    contact: t('fixtures.dev-day.74070c0b7f'),
    problem: null,
  },
  {
    id: '10455',
    address: t('fixtures.dev-day.f7ed04dc36'),
    lat: 55.7536,
    lon: 37.6388,
    title: t('fixtures.dev-day.9fa84e238b'),
    skill: 'connection',
    durationMin: 35,
    window: [13, 17],
    contact: t('fixtures.dev-day.0a79edc28f'),
    problem: null,
  },
  {
    id: '10458',
    address: t('fixtures.dev-day.caecac9f32'),
    lat: 55.7578,
    lon: 37.638,
    title: t('fixtures.dev-day.7de9e2be0d'),
    skill: 'local',
    durationMin: 45,
    window: [10, 14],
    contact: t('fixtures.dev-day.6ac8c890fe'),
    problem: null,
  },
  {
    id: '10461',
    address: t('fixtures.dev-day.70d36df4a3'),
    lat: 55.741,
    lon: 37.598,
    title: t('fixtures.dev-day.267805bd26'),
    skill: 'connection',
    durationMin: 40,
    window: [8, 12],
    contact: t('fixtures.dev-day.44685ed2bc'),
    problem: null,
  },
  {
    id: '10464',
    address: t('fixtures.dev-day.be99da6b63'),
    lat: 55.7618,
    lon: 37.6205,
    title: t('fixtures.dev-day.1e0fd1a7f5'),
    skill: 'connection',
    durationMin: 25,
    window: [12, 16],
    contact: t('fixtures.dev-day.e422569c14'),
    problem: null,
  },
  {
    id: '10467',
    address: t('fixtures.dev-day.0356714e6f'),
    lat: 55.7609,
    lon: 37.6389,
    title: t('fixtures.dev-day.9fa84e238b'),
    skill: 'connection',
    durationMin: 30,
    window: [9, 13],
    contact: t('fixtures.dev-day.a5f1e7700a'),
    problem: null,
  },
  {
    id: '10470',
    address: t('fixtures.dev-day.8e287bc765'),
    lat: 55.7574,
    lon: 37.5998,
    title: t('fixtures.dev-day.e887da99bb'),
    skill: 'local',
    durationMin: 20,
    window: [14, 17],
    contact: t('fixtures.dev-day.80ce1170f1'),
    problem: null,
  },
  {
    id: '10473',
    address: t('fixtures.dev-day.1d873bb5bd'),
    lat: 55.7358,
    lon: 37.6145,
    title: t('fixtures.dev-day.267805bd26'),
    skill: 'connection',
    durationMin: 45,
    window: [10, 15],
    contact: t('fixtures.dev-day.85e88b1927'),
    problem: null,
  },
  {
    id: '10476',
    address: t('fixtures.dev-day.1257d6b25b'),
    lat: 55.7466,
    lon: 37.6066,
    title: t('fixtures.dev-day.ce012f2374'),
    skill: 'local',
    durationMin: 30,
    window: [8, 11],
    contact: t('fixtures.dev-day.30ae27406b'),
    problem: null,
    lifecycle: 'completed',
  },
  {
    id: '10479',
    address: t('fixtures.dev-day.dff5cb4f06'),
    lat: 55.765,
    lon: 37.6155,
    title: t('fixtures.dev-day.9fa84e238b'),
    skill: 'connection',
    durationMin: 35,
    window: [8, 12],
    contact: t('fixtures.dev-day.07904a27d1'),
    problem: null,
    lifecycle: 'completed',
  },
  {
    id: '10490',
    address: t('fixtures.dev-day.af0788e96f'),
    lat: 55.7629,
    lon: 37.6239,
    title: t('fixtures.dev-day.b64b8f4a54'),
    skill: 'video',
    durationMin: 90,
    window: [10, 16],
    priority: 'urgent',
    contact: t('fixtures.dev-day.19c5b3f7f6'),
    problem: t('fixtures.dev-day.eecc1b3bc6'),
  },
  {
    id: '10491',
    address: t('fixtures.dev-day.5e7bc8d27b'),
    lat: 55.7218,
    lon: 37.6112,
    title: t('fixtures.dev-day.8f9249237e'),
    skill: 'video',
    durationMin: 80,
    window: [12, 17],
    contact: t('fixtures.dev-day.7549ebe1b3'),
    problem: t('fixtures.dev-day.a5a2ce79cd'),
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
    region: 'moscow',
    lat: place.lat,
    lon: place.lon,
    needsGeocoding: false,
    geocodeQuality: 'fixture',
    requiredEquipment:
      Number(place.id) % 4 === 0
        ? 'router'
        : Number(place.id) % 4 === 1
          ? 'set_top_box'
          : Number(place.id) % 4 === 2
            ? 'smart_speaker'
            : null,
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
    email: `${id}@navix.example`,
    day: {
      engineerId: id,
      workDate: DEV_WORK_DATE,
      version: 1,
      shiftStartAt: moscowAt(DEV_WORK_DATE, 8),
      shiftEndAt: moscowAt(DEV_WORK_DATE, 17),
      availability: 'online',
      expectedOnlineAt: null,
      equipmentStock: {
        router: 3,
        setTopBox: 3,
        smartSpeaker: 3,
      },
      equipmentIssuedAt: moscowAt(DEV_WORK_DATE, 7, 45),
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
  engineer(
    'eng-sokolov',
    t('fixtures.dev-day.05f56c34dd'),
    0,
    ['connection', 'local'],
    [55.75, 37.6],
  ),
  engineer(
    'eng-volkova',
    t('fixtures.dev-day.72fcbc1272'),
    1,
    ['connection', 'local'],
    [55.76, 37.62],
  ),
  engineer('eng-alexandrov', t('fixtures.dev-day.9d9729f6de'), 2, ['connection'], [55.74, 37.61]),
  engineer(
    'eng-petrov',
    t('fixtures.dev-day.2b8929bad3'),
    3,
    ['local', 'connection'],
    [55.755, 37.64],
  ),
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
    legs: [],
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
        { code: 'skill_match', ok: true, detail: t('fixtures.dev-day.cc3fd9e1a3') },
        {
          code: 'equipment_ok',
          ok: true,
          detail: t('fixtures.dev-day.4e21869b70'),
        },
        {
          code: 'sla_margin',
          ok: true,
          value: marginMin,
          detail: t('fixtures.dev-day.6bf9a6d4c8', { value0: marginMin }),
        },
        {
          code: 'travel_delta',
          ok: true,
          value: travelMin,
          detail: t('fixtures.dev-day.2aee72470a', { value0: travelMin }),
        },
      ],
      alternatives: [
        {
          engineerId: 'eng-volkova',
          blocked: false,
          costDeltaMin: 18,
          whyNot: t('fixtures.dev-day.8d1d5d352b'),
        },
        {
          engineerId: 'eng-alexandrov',
          blocked: true,
          whyNot: t('fixtures.dev-day.23a63d5082'),
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
          detail: t('fixtures.dev-day.e293cde202', { value0: skill }),
        },
      ],
      alternatives: ENGINEERS.map((item) => ({
        engineerId: item.id,
        blocked: true,
        whyNot: t('fixtures.dev-day.365e50b238', { value0: skill }),
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
    reasons: [t('fixtures.dev-day.a5a2ce79cd')],
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
    routerContextVersion: 'fixture-context-v1',
    policies: POLICIES,
    engineers: ENGINEERS,
    requests: REQUESTS,
    plan: {
      mode: 'auto',
      modeVersion: 1,
      plan: planWithLunches(plan, false),
      appliedResult: {
        resultId: `res-${plan.revision}`,
        inputHash: `fixture-input-${plan.revision}`,
        routerContextVersion: 'fixture-context-v1',
      },
      lastResult: {
        resultId: `res-${plan.revision}`,
        inputHash: `fixture-input-${plan.revision}`,
        routerContextVersion: 'fixture-context-v1',
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
