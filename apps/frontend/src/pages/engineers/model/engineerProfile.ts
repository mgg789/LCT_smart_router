import type { EngineerView, TransportType } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { skillTitle } from '@/entities/request';

const TRANSPORT_TITLES: Record<TransportType, string> = {
  car: 'Легковой автомобиль',
  walk: 'Пешком',
  bike: 'Велосипед',
  transit: 'Общественный транспорт',
};

export function transportTitle(transport: TransportType): string {
  return TRANSPORT_TITLES[transport] ?? transport;
}

export interface ProfileStop {
  /** Position in the plan; stable, unlike an array index. */
  sequence: number;
  requestId: string | null;
  title: string;
  startAt: number;
  endAt: number;
  done: boolean;
  running: boolean;
}

export interface EngineerProfile {
  id: string;
  name: string;
  email: string | null;
  skills: string[];
  transport: string;
  /** The API gives the crew's base as coordinates only — there is no address. */
  baseLat: number | null;
  baseLon: number | null;
  shiftStartAt: number | null;
  shiftEndAt: number | null;
  availability: 'online' | 'offline' | null;
  lunch: EngineerView['day'] extends null
    ? never
    : NonNullable<EngineerView['day']>['lunch'] | null;
  distanceKm: number | null;
  assignedCount: number;
  doneCount: number;
  stops: ProfileStop[];
  /** The stop under way, or the next one the plan has for this crew. */
  current: ProfileStop | null;
  nextStartAt: number | null;
}

/**
 * Everything the profile screen shows about one crew, drawn from the three
 * endpoints that each know a part of it.
 *
 * What is planned comes from the route; what happened comes from the requests'
 * lifecycle. A stop with no request behind it — a wait, a lunch — keeps its own
 * name instead of borrowing an address it does not have.
 */
export function buildEngineerProfile(
  engineer: EngineerView,
  plan: PlanView | null,
  requests: RequestView[],
): EngineerProfile {
  const byId = new Map(requests.map((request) => [request.id, request]));
  const route = plan?.routes.find((candidate) => candidate.engineerId === engineer.id) ?? null;

  const stops: ProfileStop[] = (route?.stops ?? []).map((stop) => {
    const request = stop.requestId ? byId.get(stop.requestId) : undefined;
    return {
      sequence: stop.sequence,
      requestId: stop.requestId,
      title: request?.addressText ?? (stop.kind === 'lunch' ? 'Обед' : 'Ожидание'),
      startAt: stop.startAt,
      endAt: stop.endAt,
      done: request?.lifecycle === 'completed',
      running: request?.lifecycle === 'in_progress',
    };
  });

  const current = stops.find((stop) => stop.running) ?? stops.find((stop) => !stop.done) ?? null;
  const currentIndex = current ? stops.indexOf(current) : -1;
  const next = currentIndex >= 0 ? (stops[currentIndex + 1] ?? null) : null;

  const assignedIds = (plan?.assignments ?? [])
    .filter(
      (assignment) => assignment.status === 'assigned' && assignment.engineerId === engineer.id,
    )
    .map((assignment) => assignment.requestId);

  return {
    id: engineer.id,
    name: engineer.displayName,
    email: engineer.email,
    skills: engineer.skills.map(skillTitle),
    transport: transportTitle(engineer.transportType),
    baseLat: engineer.homeLat,
    baseLon: engineer.homeLon,
    shiftStartAt: engineer.day?.shiftStartAt ?? null,
    shiftEndAt: engineer.day?.shiftEndAt ?? null,
    availability: engineer.day?.availability ?? null,
    lunch: engineer.day?.lunch ?? null,
    distanceKm: route?.distanceKm ?? null,
    assignedCount: route?.assignedCount ?? assignedIds.length,
    doneCount: assignedIds.filter((id) => byId.get(id)?.lifecycle === 'completed').length,
    stops,
    current,
    nextStartAt: next?.startAt ?? null,
  };
}
