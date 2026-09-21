import { moscowWorkDate } from '../figma-dashboard/welcomeDay';
import { moscowAt } from '../lib/time';
import { CLIENT_ASSETS } from './assets';

export type ClientMapPoint = { lat: number; lon: number };

/** Default Moscow center until the client picks a point on the form map. */
export const CLIENT_MAP_CENTER: ClientMapPoint = { lat: 55.7558, lon: 37.6173 };

export const CLIENT_PROBLEMS = [
  'Интернет не работает',
  'Починить роутер',
  'IP-телефония',
  'Подключение офиса',
  'Настроить Wi-Fi',
  'Другое...',
] as const;

export type ClientProblem = (typeof CLIENT_PROBLEMS)[number];

/**
 * Customer wording on the form, and the catalogue code the router actually plans.
 * The customer never types a skill or a duration.
 */
export const CLIENT_PROBLEM_WORK: Record<
  ClientProblem,
  { workType: string; requiredEquipment?: 'router' }
> = {
  'Интернет не работает': { workType: 'no_link' },
  'Починить роутер': { workType: 'router_replacement', requiredEquipment: 'router' },
  'IP-телефония': { workType: 'information' },
  'Подключение офиса': { workType: 'connection_request' },
  'Настроить Wi-Fi': { workType: 'cable_work' },
  'Другое...': { workType: 'information' },
};

export type ClientScreenId = 'new' | 'list' | 'support' | 'sent';
export type ClientRequestStatus =
  | 'en_route'
  | 'planned'
  | 'done'
  | 'assigned'
  | 'unassigned'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

/** Local preview card — first pass has no client API. */
export interface ClientRequestView {
  id: string;
  number: string;
  startAt: number;
  windowStartAt: number;
  windowEndAt: number;
  addressText: string;
  office: string | null;
  company: string;
  workTypeTitle: string;
  problemTitle: string;
  description: string;
  durationSec: number;
  status: ClientRequestStatus;
  statusLabel: string;
  engineerName: string | null;
  engineerEtaLabel: string | null;
  engineerPortrait: string | null;
  lat: number;
  lon: number;
  archived: boolean;
}

export interface ClientRequestDraft {
  problem: ClientProblem | '';
  contactName: string;
  address: string;
  windowStart: string;
  windowEnd: string;
  email: string;
  point: ClientMapPoint | null;
}

/** Fields remembered on the account after at least one sent request. */
export interface ClientProfileMemory {
  email: string;
  contactName: string | null;
  addressText: string | null;
  lat: number | null;
  lon: number | null;
}

const WORK_DATE = '2026-09-15';

/** Frozen «now» so REQUEST 115:713 shows Figma «Через 25 минут». */
export const CLIENT_DETAIL_NOW_MS = moscowAt(WORK_DATE, 11, 55) * 1000;

/** Header stamp on MAIN 115:204 — `15 сентября, 20:14`. */
export const CLIENT_LIST_NOW_MS = moscowAt(WORK_DATE, 20, 14) * 1000;

export const CLIENT_PROFILE = {
  email: 'ivanfromgorizont@gmail.com',
} as const;

export const EMPTY_CLIENT_DRAFT: ClientRequestDraft = {
  problem: 'Интернет не работает',
  contactName: '',
  address: '',
  windowStart: '12:00',
  windowEnd: '14:00',
  email: '',
  point: null,
};

export const CLIENT_PREVIEW_REQUESTS: ClientRequestView[] = [
  {
    id: 'req-1042',
    number: '1042',
    startAt: moscowAt(WORK_DATE, 12, 20),
    windowStartAt: moscowAt(WORK_DATE, 12, 0),
    windowEndAt: moscowAt(WORK_DATE, 14, 0),
    addressText: 'ул. Таганская, 24',
    office: 'офис 302',
    company: 'ООО “Горизонт”',
    workTypeTitle: 'Подключение офиса',
    problemTitle: 'Подключение интернета',
    description: 'Здесь описание проблемы',
    durationSec: 45 * 60,
    status: 'en_route',
    statusLabel: 'в пути',
    engineerName: 'Алексей Соколов',
    engineerEtaLabel: 'ваш инженер приедет к 12:20',
    engineerPortrait: CLIENT_ASSETS.portrait,
    lat: 55.7415,
    lon: 37.6536,
    archived: false,
  },
  {
    id: 'req-1038',
    number: '1038',
    startAt: moscowAt(WORK_DATE, 9, 17),
    windowStartAt: moscowAt(WORK_DATE, 9, 0),
    windowEndAt: moscowAt(WORK_DATE, 10, 20),
    addressText: 'Офис - ул. Лесная, 7',
    office: null,
    company: 'ООО “Горизонт”',
    workTypeTitle: 'Замена роутера',
    problemTitle: 'Замена роутера',
    description: 'Роутер заменён, связь восстановлена.',
    durationSec: 45 * 60,
    status: 'done',
    statusLabel: 'выполнена',
    engineerName: null,
    engineerEtaLabel: null,
    engineerPortrait: null,
    lat: 55.779,
    lon: 37.591,
    archived: true,
  },
  {
    id: 'req-1037',
    number: '1037',
    startAt: moscowAt(WORK_DATE, 9, 17),
    windowStartAt: moscowAt(WORK_DATE, 9, 0),
    windowEndAt: moscowAt(WORK_DATE, 10, 20),
    addressText: 'Офис - ул. Лесная, 7',
    office: null,
    company: 'ООО “Горизонт”',
    workTypeTitle: 'Замена роутера',
    problemTitle: 'Замена роутера',
    description: 'Роутер заменён, связь восстановлена.',
    durationSec: 45 * 60,
    status: 'done',
    statusLabel: 'выполнена',
    engineerName: null,
    engineerEtaLabel: null,
    engineerPortrait: null,
    lat: 55.779,
    lon: 37.591,
    archived: true,
  },
];

/** Featured live card, other open cards, then archive — MAIN 115:204. */
export function splitClientRequests(requests: readonly ClientRequestView[]): {
  featured: ClientRequestView | null;
  rest: ClientRequestView[];
  archive: ClientRequestView[];
} {
  const live = requests.filter((item) => !item.archived);
  const archive = requests.filter((item) => item.archived);
  const featured = live.find((item) => item.status === 'en_route') ?? live[0] ?? null;
  return {
    featured,
    rest: live.filter((item) => item.id !== featured?.id),
    archive,
  };
}

/**
 * Open work on «Мои заявки»: assigned, not yet assigned (including a result
 * that is still pending), and a visit already in progress.
 * Completed and cancelled stay in the archive.
 */
export function isActualClientRequest(input: {
  lifecycle: string;
  assignmentState: string;
}): boolean {
  if (input.lifecycle === 'in_progress') return true;
  if (input.lifecycle !== 'submitted') return false;
  return (
    input.assignmentState === 'assigned' ||
    input.assignmentState === 'unassigned' ||
    input.assignmentState === 'pending'
  );
}

/** Russian status the customer sees. Pending is still «not assigned». */
export function clientStatusLabel(input: { lifecycle: string; assignmentState: string }): string {
  if (input.lifecycle === 'in_progress') return 'В работе';
  if (input.lifecycle === 'completed') return 'Выполнена';
  if (input.lifecycle === 'cancelled') return 'Отменена';
  if (input.lifecycle === 'submitted' && input.assignmentState === 'assigned') return 'Назначена';
  if (input.lifecycle === 'submitted') return 'Не назначена';
  return 'Черновик';
}

/** True when the form has enough to ask for the email code. */
export function canSubmitClientForm(draft: ClientRequestDraft): boolean {
  return clientPrepareBody(draft) !== null;
}

/**
 * Body of `POST /client/requests/submitted`, without the operation id.
 * Returns null until name, address, map point, window and email are usable.
 * The request itself is not created here.
 */
export function clientPrepareBody(
  draft: ClientRequestDraft,
  nowMs = Date.now(),
): {
  contactName: string;
  addressText: string;
  lat: number;
  lon: number;
  workType: string;
  requiredEquipment?: 'router';
  windowStartAt: number;
  windowEndAt: number;
  urgent: boolean;
  problemText: string;
} | null {
  const problem = draft.problem;
  if (problem === '') return null;
  const contactName = draft.contactName.trim();
  const addressText = draft.address.trim();
  const email = draft.email.trim();
  if (contactName.length === 0 || addressText.length === 0 || !email.includes('@')) return null;
  if (!isClock(draft.windowStart) || !isClock(draft.windowEnd) || draft.point === null) return null;
  const [startHour, startMinute] = parseClock(draft.windowStart);
  const [endHour, endMinute] = parseClock(draft.windowEnd);
  const workDate = moscowWorkDate(nowMs);
  const windowStartAt = moscowAt(workDate, startHour, startMinute);
  const windowEndAt = moscowAt(workDate, endHour, endMinute);
  if (windowEndAt <= windowStartAt) return null;
  const work = CLIENT_PROBLEM_WORK[problem];
  return {
    contactName,
    addressText,
    lat: draft.point.lat,
    lon: draft.point.lon,
    workType: work.workType,
    ...(work.requiredEquipment === undefined ? {} : { requiredEquipment: work.requiredEquipment }),
    windowStartAt,
    windowEndAt,
    urgent: false,
    problemText: problem,
  };
}

/**
 * Fills only the blanks. A value the customer already typed stays.
 * Name, address and the map point appear only after a sent request exists.
 */
export function prefillClientDraft(
  draft: ClientRequestDraft,
  profile: ClientProfileMemory,
): ClientRequestDraft {
  return {
    ...draft,
    email: draft.email.trim().length > 0 ? draft.email : profile.email,
    contactName:
      draft.contactName.trim().length > 0 ? draft.contactName : (profile.contactName ?? ''),
    address: draft.address.trim().length > 0 ? draft.address : (profile.addressText ?? ''),
    point:
      draft.point ??
      (profile.lat !== null && profile.lon !== null
        ? { lat: profile.lat, lon: profile.lon }
        : null),
  };
}

/** Next visible ticket number from the current preview list. */
export function nextClientRequestNumber(requests: readonly ClientRequestView[]): string {
  return String(requests.reduce((max, item) => Math.max(max, Number(item.number) || 0), 0) + 1);
}

/**
 * Turns the local form into a list card. A picked map point wins;
 * otherwise the form stays on the Moscow preview center.
 */
export function requestFromDraft(
  draft: ClientRequestDraft,
  number: string,
  workDate = moscowWorkDate(),
): ClientRequestView {
  const [startHour, startMinute] = parseClock(draft.windowStart);
  const [endHour, endMinute] = parseClock(draft.windowEnd);
  const point = draft.point ?? CLIENT_MAP_CENTER;
  return {
    id: `draft-${number}`,
    number,
    startAt: moscowAt(workDate, startHour, startMinute),
    windowStartAt: moscowAt(workDate, startHour, startMinute),
    windowEndAt: moscowAt(workDate, endHour, endMinute),
    addressText: draft.address.trim(),
    office: null,
    company: '',
    workTypeTitle: draft.problem || 'Новая заявка',
    problemTitle: draft.problem || 'Новая заявка',
    description: 'Заявка отправлена. Описание появится после разбора диспетчером.',
    durationSec: 45 * 60,
    status: 'planned',
    statusLabel: 'принята',
    engineerName: null,
    engineerEtaLabel: null,
    engineerPortrait: null,
    lat: point.lat,
    lon: point.lon,
    archived: false,
  };
}

function isClock(value: string): boolean {
  return /^\d{2}:\d{2}$/.test(value);
}

function parseClock(value: string): [number, number] {
  const [hourText, minuteText] = value.split(':');
  return [Number(hourText), Number(minuteText)];
}
