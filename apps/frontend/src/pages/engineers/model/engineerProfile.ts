import type { EngineerView, TransportType } from '@/entities/engineer';
import { transportTitleOf } from '@/entities/engineer';
import type { CrewTally, DispatchLiveView } from '@/entities/live';
import { crewTally } from '@/entities/live';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { skillTitle } from '@/entities/request';

/** Re-exported so the profile screen keeps one import for its labels. */
export function transportTitle(transport: TransportType): string {
  return transportTitleOf(transport);
}

export interface ProfileStop {
  /** Position in the plan; stable, unlike an array index. */
  sequence: number;
  requestId: string | null;
  /** Short form of the id: the API ships no human-readable request number. */
  number: string | null;
  title: string;
  contactName: string | null;
  /** Planned, never a fact — `arrivalAt ≤ startAt ≤ endAt` (§6.5). */
  arrivalAt: number;
  startAt: number;
  endAt: number;
  done: boolean;
  running: boolean;
  /** How a closed visit ended; `null` while it is still ahead or under way. */
  outcome: 'completed' | 'cancelled' | 'assumed_completed' | null;
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
  lunch: NonNullable<EngineerView['day']>['lunch'] | null;
  distanceKm: number | null;
  assignedCount: number;
  routeStartAt: number | null;
  routeFinishAt: number | null;
  /** «выполнено N/M» from the LIVE day; `null` when it does not know the crew. */
  tally: CrewTally | null;
  /** The crew's closed visits, oldest first, then the route still ahead. */
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
 *
 * The plan holds only the work ahead: a visit leaves it once it is started or
 * closed. What is behind the crew comes from the LIVE day instead — its tally
 * and its history of closed visits, which lead the crew's line of stops.
 */
export function buildEngineerProfile(
  engineer: EngineerView,
  plan: PlanView | null,
  requests: RequestView[],
  live: DispatchLiveView | null = null,
): EngineerProfile {
  const byId = new Map(requests.map((request) => [request.id, request]));
  const route = plan?.routes.find((candidate) => candidate.engineerId === engineer.id) ?? null;

  const stops: ProfileStop[] = (route?.stops ?? []).map((stop) => {
    const request = stop.requestId ? byId.get(stop.requestId) : undefined;
    return {
      sequence: stop.sequence,
      requestId: stop.requestId,
      number: stop.requestId ? stop.requestId.slice(0, 8) : null,
      title: request?.addressText ?? (stop.kind === 'lunch' ? 'Обед' : 'Ожидание'),
      contactName: request?.contactName ?? null,
      arrivalAt: stop.arrivalAt,
      startAt: stop.startAt,
      endAt: stop.endAt,
      done: request?.lifecycle === 'completed',
      running: request?.lifecycle === 'in_progress',
      outcome: null,
    };
  });

  const closed: ProfileStop[] = (live?.history ?? [])
    .filter((entry) => entry.engineerId === engineer.id)
    .sort((left, right) => left.terminalAt - right.terminalAt)
    .map((entry) => ({
      // Closed visits sit before everything still planned; negative keeps the key unique.
      sequence: -1 - (entry.stop?.sequence ?? 0) - entry.terminalAt,
      requestId: entry.request.id,
      number: entry.request.id.slice(0, 8),
      title: entry.request.addressText,
      contactName: entry.request.contactName,
      arrivalAt: entry.stop?.arrivalAt ?? entry.terminalAt,
      startAt: entry.stop?.startAt ?? entry.terminalAt,
      endAt: entry.terminalAt,
      done: entry.outcome !== 'cancelled',
      running: false,
      outcome: entry.outcome,
    }));

  const liveState = live?.engineers.find((state) => state.id === engineer.id);
  const activeId = liveState?.activeRequestId ?? null;
  const current =
    stops.find((stop) => stop.running || (activeId !== null && stop.requestId === activeId)) ??
    stops.find((stop) => !stop.done) ??
    null;
  const currentIndex = current ? stops.indexOf(current) : -1;
  const next = currentIndex >= 0 ? (stops[currentIndex + 1] ?? null) : null;

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
    assignedCount: route?.assignedCount ?? 0,
    routeStartAt: route?.startAt ?? null,
    routeFinishAt: route?.finishAt ?? null,
    tally: crewTally(
      liveState,
      stops.flatMap((stop) => (stop.requestId ? [stop.requestId] : [])),
    ),
    stops: [...closed, ...stops],
    current,
    nextStartAt: next?.startAt ?? null,
  };
}

/**
 * How much of the planned route is already behind, by the clock, in `0…1`.
 *
 * This is the honest stand-in for the mockup's completion bar: the plan carries
 * the day's shape but not the crew's tally of finished work.
 */
export function routeElapsedShare(profile: EngineerProfile, nowSeconds: number): number {
  const { routeStartAt, routeFinishAt } = profile;
  if (routeStartAt === null || routeFinishAt === null) return 0;
  const span = routeFinishAt - routeStartAt;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (nowSeconds - routeStartAt) / span));
}
