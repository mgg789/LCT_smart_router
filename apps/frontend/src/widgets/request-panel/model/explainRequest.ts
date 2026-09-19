import type { EngineerView } from '@/entities/engineer';
import { transportTitleOf } from '@/entities/engineer';
import type { PlanAssignmentView, PlanRouteView, PlanStopView } from '@/entities/plan';
import { reasonText } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { skillTitle } from '@/entities/request';
import { formatKm, formatMinutes, formatRange, formatTime } from '@/shared/lib';

export interface RequestExplanation {
  title: string;
  /** What the data says, one statement per line. */
  facts: string[];
  /** How those facts led to this outcome. */
  influence: string;
  result: string;
  /**
   * True when every reason the solver gave is the outcome of a limited search
   * rather than a checked constraint — the UI must not read as a proof then.
   */
  fromSearchOnly: boolean;
}

function inboundTravel(route: PlanRouteView | null, stop: PlanStopView | null) {
  if (!route || !stop) return null;
  const previous = route.stops.filter((item) => item.sequence < stop.sequence).at(-1);
  if (!previous) return null;
  return { previous, travelSec: Math.max(0, stop.arrivalAt - previous.endAt) };
}

function crewsInRegion(engineers: EngineerView[], region: string): EngineerView[] {
  return engineers.filter((engineer) => engineer.region === region);
}

/**
 * Builds the dispatcher's explanation from the snapshot itself, in the shape the
 * project settled on: facts → influence → result (`context/11`).
 *
 * Nothing here is a stock phrase: every line is assembled from the request, the
 * crew, the route and the solver's own reason codes. Where the solver only
 * reports the outcome of a limited search, the text says so instead of claiming
 * something was impossible.
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
  const demand = `Заявка требует навык «${skillTitle(request.requiredSkill)}», окно ${formatRange(
    request.windowStartAt,
    request.windowEndAt,
  )}${request.serviceDurationSec ? `, работа ${formatMinutes(request.serviceDurationSec)}` : ''}.`;

  if (request.assignmentState === 'unassigned' || !engineer) {
    const regional = crewsInRegion(engineers, request.region);
    const skilled = regional.filter((crew) => crew.skills.includes(request.requiredSkill));
    const online = skilled.filter((crew) => crew.day?.availability === 'online');

    return {
      title: 'Почему без назначения?',
      facts: [
        demand,
        `В регионе «${request.region}» ${regional.length} бригад, из них ${skilled.length} с нужным навыком, на смене ${online.length}.`,
        reasons.length > 0
          ? `Решатель вернул: ${reasons.map(reasonText).join('; ')}.`
          : 'Решатель не прислал причин для этой заявки.',
      ],
      influence: fromSearchOnly
        ? 'Это исход ограниченного поиска, а не доказательство невозможности: при другой политике или большем бюджете расчёта заявка может разместиться.'
        : 'Ограничение проверено решателем — заявку нельзя отдать ни одной из подходящих бригад в этом окне.',
      result: 'Заявка осталась без назначения.',
      fromSearchOnly,
    };
  }

  const stop = route?.stops.find((item) => item.requestId === request.id) ?? null;
  const inbound = inboundTravel(route, stop);
  const margin = stop ? request.windowEndAt - stop.startAt : null;

  const facts = [
    demand,
    `${engineer.displayName}: навыки ${engineer.skills.map(skillTitle).join(', ') || 'не указаны'}; транспорт ${transportTitleOf(engineer.transportType)}; в маршруте ${route?.assignedCount ?? 0} заявок${route ? `, пробег ${formatKm(route.distanceKm)}` : ''}.`,
    inbound
      ? `До этой точки маршрут шёл с предыдущей остановки, доезд ${formatMinutes(inbound.travelSec)}.`
      : 'Это первая работа после старта смены.',
    stop
      ? `Начало в ${formatTime(stop.startAt)}${margin !== null ? `, запас до конца окна ${formatMinutes(margin)}` : ''}.`
      : `Окно клиента ${formatRange(request.windowStartAt, request.windowEndAt)}.`,
  ];

  const hasSkill = engineer.skills.includes(request.requiredSkill);
  const influence = [
    hasSkill
      ? `Навык «${skillTitle(request.requiredSkill)}» у бригады есть — назначение допустимо.`
      : 'Решатель признал назначение допустимым по навыку, транспорту и смене.',
    margin !== null && margin >= 0
      ? 'Приезд укладывается в окно клиента, поэтому заявка удержана за этой бригадой.'
      : 'Окно клиента учитывалось как ограничение при выборе слота.',
    reasons.length > 0 ? `Решатель отметил: ${reasons.map(reasonText).join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    title: `Почему ${engineer.displayName}?`,
    facts,
    influence,
    result: `Заявка назначена: ${engineer.displayName}.`,
    fromSearchOnly,
  };
}
