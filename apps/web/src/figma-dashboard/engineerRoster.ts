import type { HandoffView } from '../api/live';
import type { DashboardSnapshot, EngineerDayView, PlanStopView, RequestView } from '../api/types';
import { requestById, routeForEngineer } from '../domain/dashboard';
import { regionStyle } from '../domain/regions';
import { skillLabel } from '../lib/reasons';
import { formatClock } from '../lib/time';
import { officesForRegion, SKILL_OPTIONS } from './addEntity';
import { givenName } from './engineerRing';
import { requestCountLabel } from './fixtures';
import { shortRequestId } from './requestsTable';

const TRANSPORT_COPY: Record<string, string> = {
  car: 'Легковой, до 3.5 т',
  walk: 'Пешком',
  bike: 'Велосипед',
  transit: 'Общественный транспорт',
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EngineerJobActivity = {
  readonly kind: 'job';
  readonly requestId: string;
  readonly title: string;
  readonly address: string;
  readonly client: string | null;
  readonly arrived: string | null;
  readonly startClock: string;
  readonly finishClock: string;
  readonly nextTitle: string | null;
  readonly nextClock: string | null;
};

export type EngineerPauseActivity = {
  readonly kind: 'lunch' | 'break' | 'handoff';
  readonly title: string;
  readonly subtitle?: string;
  readonly startClock: string | null;
  readonly untilClock: string | null;
  readonly nextTitle: string | null;
  readonly nextClock: string | null;
};

export type EngineerActivity =
  | EngineerJobActivity
  | EngineerPauseActivity
  | { readonly kind: 'empty' };

export type EngineerProfile = {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly givenName: string;
  readonly email: string | null;
  readonly hasAccount: boolean;
  readonly skills: readonly string[];
  readonly skillLabels: readonly string[];
  readonly transportLabel: string;
  readonly officeLabel: string;
  readonly assignedCount: number;
  readonly cardStatus: string;
  readonly photoIndex: number;
  readonly availability: 'online' | 'offline' | 'technical_break' | null;
  readonly activity: EngineerActivity;
};

/**
 * True when the string is a plausible login address (same shape as the add-entity form).
 */
export function isPlausibleEmail(value: string): boolean {
  return EMAIL_SHAPE.test(value.trim());
}

/**
 * First bind uses `link-account`; an already-linked login uses PATCH `.../account`.
 */
export function engineerEmailWriteKind(hasAccount: boolean): 'link' | 'change' {
  return hasAccount ? 'change' : 'link';
}

/**
 * Demo-pack mutation: bind or replace a login address on the local snapshot.
 */
export function bindEngineerEmailInSnapshot(
  snapshot: DashboardSnapshot,
  engineerId: string,
  email: string,
): DashboardSnapshot {
  return {
    ...snapshot,
    engineers: snapshot.engineers.map((item) =>
      item.id === engineerId ? { ...item, email, hasAccount: true } : item,
    ),
  };
}

/**
 * Demo-pack mutation: drop a roster row and its planned work.
 */
export function dropEngineerFromSnapshot(
  snapshot: DashboardSnapshot,
  engineerId: string,
): DashboardSnapshot {
  const plan = snapshot.plan.plan;
  return {
    ...snapshot,
    engineers: snapshot.engineers.filter((item) => item.id !== engineerId),
    plan: {
      ...snapshot.plan,
      plan: plan
        ? {
            ...plan,
            routes: plan.routes.filter((route) => route.engineerId !== engineerId),
            assignments: plan.assignments.filter((item) => item.engineerId !== engineerId),
          }
        : null,
    },
  };
}

/**
 * Dispatcher-facing skill chip. Known codes use the add-entity labels (title case).
 */
export function skillChipLabel(skill: string): string {
  const known = SKILL_OPTIONS.find((item) => item.id === skill);
  if (known) return known.label;
  const raw = skillLabel(skill);
  if (!raw) return skill;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Figma 49:5253 transport line for a stored transport code.
 */
export function engineerTransportLabel(transport: string): string {
  return TRANSPORT_COPY[transport] ?? transport;
}

/**
 * Region label, plus a session office address when the dispatcher added one.
 */
export function engineerOfficeLabel(region: string | null): string {
  const place = regionStyle(region).label;
  if (!region) return place;
  const office = officesForRegion(region)[0];
  return office ? `${place} ${office.addressText}` : place;
}

/**
 * Portrait slot stays with the engineer: brigade number when present, else id hash.
 */
export function engineerPhotoIndex(
  engineerId: string,
  portraitCount: number,
  displayName = '',
): number {
  if (portraitCount <= 0) return 0;
  const match = displayName.match(/Бригада\s+(\d+)/i);
  if (match) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return (n - 1) % portraitCount;
  }
  let hash = 0;
  for (let i = 0; i < engineerId.length; i += 1) {
    hash = (hash * 31 + engineerId.charCodeAt(i)) >>> 0;
  }
  return hash % portraitCount;
}

/**
 * Live activity for the right half of the info block: current job, lunch, or a
 * technical break. Idle engineers leave that half empty.
 */
export function engineerActivity(
  snapshot: DashboardSnapshot,
  engineerId: string,
  nowAt: number,
  handoffs: readonly HandoffView[] = [],
): EngineerActivity {
  const engineer = snapshot.engineers.find((item) => item.id === engineerId);
  const day = engineer?.day ?? null;
  if (day?.availability === 'technical_break') {
    return {
      kind: 'break',
      title: 'Технический перерыв',
      startClock: null,
      untilClock: day.expectedOnlineAt ? formatClock(day.expectedOnlineAt) : null,
      nextTitle: null,
      nextClock: null,
    };
  }

  const route = routeForEngineer(snapshot, engineerId);
  const current = currentStop(route?.stops ?? [], nowAt);
  const currentHandoff = current?.kind === 'handoff' ? handoffForStop(current, handoffs) : null;
  if (current && currentHandoff) {
    return handoffActivity(snapshot, engineerId, currentHandoff, current.startAt);
  }
  const nextJob = inProgressJobStop(snapshot, engineerId, route?.stops ?? []);
  const nextHandoff = handoffs
    .filter(
      (item) =>
        item.completedAt === null &&
        (item.donorEngineerId === engineerId || item.receiverEngineerId === engineerId),
    )
    .find((item) => item.meetingAt >= nowAt && (!nextJob || item.meetingAt <= nextJob.startAt));
  if (nextHandoff) return handoffActivity(snapshot, engineerId, nextHandoff, nextHandoff.meetingAt);
  if (current?.kind === 'lunch' || isOpenLunch(day, nowAt)) {
    const until = current?.kind === 'lunch' ? current.endAt : day?.lunch.windowEndAt;
    const lunchStart = day?.lunch.startedAt ?? (current?.kind === 'lunch' ? current.startAt : null);
    const next = nextJobAfter(route?.stops ?? [], current?.endAt ?? lunchStart ?? nowAt);
    return {
      kind: 'lunch',
      title: 'Обед',
      startClock: lunchStart ? formatClock(lunchStart) : null,
      untilClock: until ? formatClock(until) : null,
      nextTitle: next ? `Заявка № ${shortRequestId(next.requestId ?? '')}` : null,
      nextClock: next ? formatClock(next.startAt) : null,
    };
  }

  const jobStop = current?.kind === 'job' ? current : nextJob;
  if (jobStop?.requestId) {
    const request = requestById(snapshot, jobStop.requestId);
    if (request) {
      return jobActivity(request, jobStop, route?.stops ?? []);
    }
  }

  return { kind: 'empty' };
}

/**
 * Ordered roster for the Engineers tab. Input order stays cyclic on the ring.
 */
export function engineerProfilesFromSnapshot(
  snapshot: DashboardSnapshot | null,
  handoffs: readonly HandoffView[] = [],
): EngineerProfile[] {
  if (!snapshot) return [];
  const nowAt = snapshot.nowAt;
  return [...snapshot.engineers]
    .sort(
      (left, right) =>
        left.inputOrder - right.inputOrder ||
        left.displayName.localeCompare(right.displayName, 'ru'),
    )
    .map((engineer) => {
      const assignments =
        snapshot.plan.plan?.assignments.filter(
          (assignment) =>
            assignment.engineerId === engineer.id && assignment.status !== 'unassigned',
        ) ?? [];
      const assignedCount = assignments.length;
      const activity = engineerActivity(snapshot, engineer.id, nowAt, handoffs);
      return {
        id: engineer.id,
        version: engineer.version,
        displayName: engineer.displayName,
        givenName: givenName(engineer.displayName),
        email: engineer.email,
        hasAccount: engineer.hasAccount,
        skills: engineer.skills,
        skillLabels: engineer.skills.map(skillChipLabel),
        transportLabel: engineerTransportLabel(engineer.transportType),
        officeLabel: engineerOfficeLabel(engineer.region),
        assignedCount,
        cardStatus: cardStatus(activity, engineer.day?.availability ?? null, assignedCount),
        photoIndex: engineerPhotoIndex(engineer.id, 3, engineer.displayName),
        availability: engineer.day?.availability ?? null,
        activity,
      };
    });
}

function cardStatus(
  activity: EngineerActivity,
  availability: 'online' | 'offline' | 'technical_break' | null,
  assignedCount: number,
): string {
  if (activity.kind === 'break' || availability === 'technical_break') return 'техперерыв';
  if (activity.kind === 'handoff') return 'передача';
  if (activity.kind === 'lunch') return 'обед';
  if (availability === 'offline') return 'не на смене';
  return `в работе - ${requestCountLabel(assignedCount)}`;
}

function handoffForStop(stop: PlanStopView, handoffs: readonly HandoffView[]): HandoffView | null {
  const id = stop.handoff?.handoff_id;
  return handoffs.find((item) => item.id === id) ?? null;
}

function handoffActivity(
  snapshot: DashboardSnapshot,
  engineerId: string,
  handoff: HandoffView,
  meetingAt: number,
): EngineerPauseActivity {
  const donor =
    snapshot.engineers.find((item) => item.id === handoff.donorEngineerId)?.displayName ??
    handoff.donorEngineerId;
  const receiver =
    snapshot.engineers.find((item) => item.id === handoff.receiverEngineerId)?.displayName ??
    handoff.receiverEngineerId;
  const action = engineerId === handoff.donorEngineerId ? 'Передать' : 'Принять';
  return {
    kind: 'handoff',
    title: 'Передача оборудования',
    subtitle: `${action} · ${donor} → ${receiver} · ${handoffItemsLabel(handoff)}`,
    startClock: formatClock(meetingAt),
    untilClock: formatClock(meetingAt + 300),
    nextTitle: null,
    nextClock: null,
  };
}

function handoffItemsLabel(handoff: HandoffView): string {
  return [
    handoff.items.router ? `роутер ×${handoff.items.router}` : null,
    handoff.items.set_top_box ? `ТВ-приставка ×${handoff.items.set_top_box}` : null,
    handoff.items.smart_speaker ? `умная колонка ×${handoff.items.smart_speaker}` : null,
  ]
    .filter((item): item is string => item !== null)
    .join(', ');
}

function currentStop(stops: readonly PlanStopView[], nowAt: number): PlanStopView | null {
  return stops.find((stop) => stop.startAt <= nowAt && nowAt < stop.endAt) ?? null;
}

function isOpenLunch(day: EngineerDayView | null, nowAt: number): boolean {
  if (!day?.lunch.enabled || day.lunch.taken || day.lunch.startedAt === null) return false;
  return day.lunch.startedAt <= nowAt;
}

function inProgressJobStop(
  snapshot: DashboardSnapshot,
  engineerId: string,
  stops: readonly PlanStopView[],
): PlanStopView | null {
  const inProgress = snapshot.requests.find((request) => {
    if (request.lifecycle !== 'in_progress') return false;
    const assignment = snapshot.plan.plan?.assignments.find(
      (item) => item.requestId === request.id,
    );
    return assignment?.engineerId === engineerId;
  });
  if (!inProgress) return null;
  return stops.find((stop) => stop.requestId === inProgress.id) ?? null;
}

function jobActivity(
  request: RequestView,
  stop: PlanStopView,
  stops: readonly PlanStopView[],
): EngineerJobActivity {
  const finishAt = request.expectedCompletionAt ?? stop.endAt;
  const next = nextJobAfter(stops, stop.endAt, request.id);
  const startAt = request.startedAt ?? stop.startAt;
  return {
    kind: 'job',
    requestId: request.id,
    title: `Заявка № ${shortRequestId(request.id)}`,
    address: shortAddress(request.addressText),
    client: request.contactName,
    arrived: request.startedAt ? `Прибыл в ${formatClock(request.startedAt)}` : null,
    startClock: formatClock(startAt),
    finishClock: formatClock(finishAt),
    nextTitle: next ? `Заявка № ${shortRequestId(next.requestId ?? '')}` : null,
    nextClock: next ? formatClock(next.startAt) : null,
  };
}

function nextJobAfter(
  stops: readonly PlanStopView[],
  afterAt: number,
  excludeRequestId?: string,
): PlanStopView | null {
  return (
    stops
      .filter(
        (item) =>
          item.kind === 'job' &&
          item.requestId !== null &&
          item.startAt >= afterAt &&
          item.requestId !== excludeRequestId,
      )
      .sort((left, right) => left.startAt - right.startAt)[0] ?? null
  );
}

function shortAddress(address: string): string {
  const parts = address
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 2) return address;
  return parts.slice(-2).join(', ');
}
