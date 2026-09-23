import type { EngineerView } from '@/entities/engineer';
import type { PlanAssignmentView, PlanRouteView, PlanStopView } from '@/entities/plan';
import { reasonText } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { skillTitle } from '@/entities/request';
import { formatKm, formatMinutes, formatRange, formatTime } from '@/shared/lib';

export interface RequestExplanation {
  title: string;
  /** Short lines — a label and its value, and the solver's own reason codes. */
  points: string[];
  /**
   * True when every reason the solver gave is the outcome of a limited search
   * rather than a checked constraint — the UI must not read as a proof then.
   */
  fromSearchOnly: boolean;
  /** One short caveat, shown only when the reasons prove nothing. */
  note: string | null;
}

function inboundTravel(route: PlanRouteView | null, stop: PlanStopView | null) {
  if (!route || !stop) return null;
  const previous = route.stops.filter((item) => item.sequence < stop.sequence).at(-1);
  if (!previous) return null;
  return Math.max(0, stop.arrivalAt - previous.endAt);
}

/**
 * The dispatcher's explanation of one assignment, as short lines.
 *
 * Every line is read off the snapshot — the request, the crew's route and the
 * solver's own reason codes — never composed from a stock phrase. It names no
 * crew: the panel already says whose the request is, and the explanation answers
 * "on what grounds", not "who".
 *
 * Where the solver only reports the outcome of a limited search, the caveat says
 * so instead of letting the list read as proof that nothing else was possible.
 */
export function explainRequest(
  request: RequestView,
  assignment: PlanAssignmentView | null,
  engineer: EngineerView | null,
  route: PlanRouteView | null,
  engineers: EngineerView[],
): RequestExplanation {
  const reasons = assignment?.reasons ?? [];
  const fromSearchOnly =
    reasons.length > 0 && reasons.every((reason) => reason.basis === 'calculation_outcome');
  const note = fromSearchOnly ? 'Исход ограниченного поиска, не доказательство.' : null;

  const demand = [
    `Навык: ${skillTitle(request.requiredSkill)}`,
    `Окно: ${formatRange(request.windowStartAt, request.windowEndAt)}`,
  ];
  if (request.serviceDurationSec) {
    demand.push(`Работа: ${formatMinutes(request.serviceDurationSec)}`);
  }

  if (request.assignmentState === 'unassigned' || !engineer) {
    const regional = engineers.filter((crew) => crew.region === request.region);
    const skilled = regional.filter((crew) => crew.skills.includes(request.requiredSkill));
    const online = skilled.filter((crew) => crew.day?.availability === 'online');

    return {
      title: 'Почему без назначения?',
      points: [
        ...demand,
        `Бригад в регионе: ${regional.length}`,
        `С нужным навыком: ${skilled.length}`,
        `Из них на смене: ${online.length}`,
        ...(reasons.length > 0 ? reasons.map(reasonText) : ['Решатель не прислал причин']),
      ],
      fromSearchOnly,
      note,
    };
  }

  const stop = route?.stops.find((item) => item.requestId === request.id) ?? null;
  const travelSec = inboundTravel(route, stop);
  const margin = stop ? request.windowEndAt - stop.startAt : null;

  return {
    title: 'Почему эта бригада?',
    points: [
      ...demand,
      travelSec === null
        ? 'Первая работа после старта смены'
        : `Доезд: ${formatMinutes(travelSec)}`,
      ...(stop ? [`Начало: ${formatTime(stop.startAt)}`] : []),
      ...(margin !== null ? [`Запас до конца окна: ${formatMinutes(margin)}`] : []),
      ...(route
        ? [`В маршруте: ${route.assignedCount} заявок · ${formatKm(route.distanceKm)}`]
        : []),
      ...reasons.map(reasonText),
    ],
    fromSearchOnly,
    note,
  };
}
