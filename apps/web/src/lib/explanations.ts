import type {
  AssignmentReasons,
  DashboardSnapshot,
  EngineerView,
  PlanAssignmentView,
  PlanRouteView,
  PolicyId,
  RequestView,
} from '../api/types';
import { engineerSummaries, requestById, unassignedRequests } from '../domain/dashboard';
import { POLICY_LABELS, skillLabel, transportLabel } from './reasons';
import { formatClock, formatDurationMin, formatKm } from './time';

export interface CaseExplanation {
  readonly title: string;
  readonly facts: string[];
  readonly influence: string;
  readonly result: string;
}

/**
 * Build a dispatcher explanation from the current snapshot, not a stock phrase.
 * Shape is always Facts → Influence → Result (context/11).
 */
export function explainSelection(
  snapshot: DashboardSnapshot,
  request: RequestView | null,
  assignment: PlanAssignmentView | null,
  engineer: EngineerView | null,
  route: PlanRouteView | null,
): CaseExplanation | null {
  if (request) {
    if (assignment?.status === 'unassigned') {
      return explainUnassigned(snapshot, request, assignment);
    }
    return explainAssigned(snapshot, request, assignment, engineer, route);
  }
  if (engineer) {
    return route && route.assignedCount > 0
      ? explainRoute(snapshot, engineer, route)
      : explainIdleEngineer(snapshot, engineer);
  }
  return null;
}

function explainAssigned(
  snapshot: DashboardSnapshot,
  request: RequestView,
  assignment: PlanAssignmentView | null,
  engineer: EngineerView | null,
  route: PlanRouteView | null,
): CaseExplanation {
  const chosen = engineer ?? snapshot.engineers.find((item) => item.id === assignment?.engineerId);
  const name = chosen?.displayName ?? 'выбранный инженер';
  const facts = assignment ? firstFactorFacts(assignment.reasons) : undefined;
  const stop = route?.stops.find((item) => item.requestId === request.id);
  const previousJob = previousRequest(snapshot, route, request.id);
  const travelMin = minutesFromFacts(facts, 'travel_time_sec', stop && route ? inboundTravelSec(route, stop.sequence) : null);
  const travelKm = numberFromFacts(facts, 'distance_km') ?? inboundDistanceKm(route, stop?.sequence ?? null);
  const marginSec = numberFromFacts(facts, 'window_end_margin_sec');
  const margin =
    marginSec ?? (stop ? request.windowEndAt - stop.startAt : null);
  const sameRegionIdle = idleInRegion(snapshot, request.region).filter(
    (item) => item.engineerId !== chosen?.id,
  );
  const skilledIdle = sameRegionIdle.filter((item) => item.skills.includes(request.requiredSkill));

  const factsLines = [
    `Заявка требует навык «${skillLabel(request.requiredSkill)}», окно ${formatClock(request.windowStartAt)}–${formatClock(request.windowEndAt)}, работа ${formatDurationMin(request.serviceDurationSec)}.`,
    chosen
      ? `${name}: навыки ${chosen.skills.map(skillLabel).join(', ') || 'не указаны'}; транспорт ${transportLabel(chosen.transportType)}; в смене уже ${route?.assignedCount ?? 0} заявок.`
      : `${name} выбран исполнителем.`,
    previousJob
      ? `До этой точки маршрут шёл с заявки №${previousJob.id}${previousJob.workTypeTitle ? ` (${previousJob.workTypeTitle})` : ''}${travelMin !== null ? `, доезд ${travelMin} мин` : ''}${travelKm !== null ? ` / ${formatKm(travelKm)}` : ''}.`
      : `Это первая работа после старта смены${travelMin !== null ? `, доезд ${travelMin} мин` : ''}${travelKm !== null ? ` / ${formatKm(travelKm)}` : ''}.`,
    stop
      ? `Начало в ${formatClock(stop.startAt)}${margin !== null ? `, запас до конца окна ${Math.round(margin / 60)} мин` : ''}.`
      : `Окно клиента ${formatClock(request.windowStartAt)}–${formatClock(request.windowEndAt)}.`,
  ];

  const influenceParts = [
    chosen?.skills.includes(request.requiredSkill)
      ? `Навык «${skillLabel(request.requiredSkill)}» есть у ${name}, поэтому назначение допустимо.`
      : `Солвер пометил назначение как допустимое по навыку, транспорту и смене.`,
    margin !== null && margin >= 0
      ? `Приезд укладывается в окно — это удерживает заявку у этого исполнителя.`
      : `Окно было учитываемым ограничением при выборе слота.`,
    skilledIdle.length
      ? `В той же зоне свободно ${skilledIdle.map((item) => item.displayName).join(', ')}, но политика «${policyTitle(snapshot.policyId)}» оставила работу на уже открытой смене.`
      : sameRegionIdle.length
        ? `Свободные в зоне (${sameRegionIdle.map((item) => item.displayName).join(', ')}) не имеют навыка «${skillLabel(request.requiredSkill)}».`
        : `Других свободных смен в этой зоне нет — новых исполнителей открывать было некого.`,
  ];

  return {
    title: `Почему ${name}?`,
    facts: factsLines,
    influence: influenceParts.join(' '),
    result: `Заявка №${request.id} назначена: ${name}.`,
  };
}

function explainUnassigned(
  snapshot: DashboardSnapshot,
  request: RequestView,
  assignment: PlanAssignmentView,
): CaseExplanation {
  const facts = firstFactorFacts(assignment.reasons);
  const code = assignment.reasons.assignment?.factors[0]?.code ?? 'NO_FEASIBLE_ASSIGNMENT_FOUND';
  const regional = engineersInRegion(snapshot, request.region);
  const skilled = regional.filter((item) => item.skills.includes(request.requiredSkill));
  const idle = idleInRegion(snapshot, request.region);
  const idleSkilled = idle.filter((item) => item.skills.includes(request.requiredSkill));
  const idleFromFacts = csv(facts, 'idle_skilled_ids').map((id) => engineerName(snapshot, id));
  const idleNames = unique(idleSkilled.map((item) => item.displayName).concat(idleFromFacts));

  const factsLines = [
    `Заявка №${request.id} требует навык «${skillLabel(request.requiredSkill)}», окно ${formatClock(request.windowStartAt)}–${formatClock(request.windowEndAt)}, работа ${formatDurationMin(request.serviceDurationSec)}.`,
    request.region
      ? `Регион заявки — ${request.region}: в смене ${regional.length} инженеров, с нужным навыком ${skilled.length}.`
      : `В смене ${snapshot.engineers.length} инженеров, с нужным навыком ${skilled.length}.`,
    idle.length
      ? `Без заявок в этой зоне: ${idle.map((item) => `${item.displayName} (${item.skills.map(skillLabel).join(', ') || 'навыки не указаны'})`).join('; ')}.`
      : 'Свободных смен в этой зоне нет — все уже открыты под другие заявки.',
    `Политика «${policyTitle(snapshot.policyId)}».`,
  ];

  let influence: string;
  if (code === 'NO_SKILL_MATCH' || code === 'skill_missing' || skilled.length === 0) {
    influence = `Ни один инженер зоны не умеет «${skillLabel(request.requiredSkill)}». Свободные смены это не чинят — им тоже не хватает навыка.`;
  } else if (code === 'NO_TRANSPORT_MATCH' || code === 'transport_mismatch') {
    influence = `Нужный навык есть, но ни у кого из этих людей нет требуемого транспорта.`;
  } else if (code === 'NO_EQUIPMENT_STOCK') {
    influence = `Совместимые инженеры есть, но у них нет нужного оборудования на утро.`;
  } else if (code === 'NO_AVAILABLE_ENGINEER' || code === 'NO_REGION_MATCH') {
    influence = `В этой зоне нет доступного исполнителя, которому можно отдать заявку.`;
  } else if (idleSkilled.length || idleNames.length) {
    influence =
      snapshot.policyId === 'compact'
        ? `Поиск не вставил заявку в уже собранные маршруты. ${idleNames.join(', ')} свободен и навык подходит, но политика «Компактнее» не открывает новую смену, пока считает, что текущие маршруты ещё должны вместить работу. Это предел расчёта, не доказанная невозможность.`
        : snapshot.policyId === 'covering'
          ? `Покрывающая политика сначала отдаёт остаток свободным в зоне, и только потом добавляет смены. ${idleNames.join(', ')} свободен, но в его смену заявка всё равно не встала — окно, доезд или уже занятый день не дали допустимого слота.`
          : `Свободный ${idleNames.join(', ')} не получил заявку: навык формально есть, но слот в смене не сошёлся по окну или доезду.`;
  } else if (idle.length) {
    influence = `Свободные ${idle.map((item) => item.displayName).join(', ')} не подходят по навыку: заявка просит «${skillLabel(request.requiredSkill)}», у них ${unique(idle.flatMap((item) => item.skills)).map(skillLabel).join(', ') || 'нет нужных навыков'}.`;
  } else {
    influence = `Все, у кого есть «${skillLabel(request.requiredSkill)}», уже ведут маршрут, и bounded-поиск не нашёл, куда вставить ещё одну точку без поломки окна.`;
  }

  return {
    title: 'Почему без назначения',
    facts: factsLines,
    influence,
    result:
      code === 'NO_SKILL_MATCH' || code === 'skill_missing' || skilled.length === 0
        ? `Заявка №${request.id} осталась без назначения: в зоне нет навыка «${skillLabel(request.requiredSkill)}».`
        : `Заявка №${request.id} осталась без назначения.`,
  };
}

function explainRoute(
  snapshot: DashboardSnapshot,
  engineer: EngineerView,
  route: PlanRouteView,
): CaseExplanation {
  const jobs = route.stops
    .filter((stop) => stop.kind === 'job' && stop.requestId)
    .map((stop) => requestById(snapshot, stop.requestId as string))
    .filter((item): item is RequestView => item !== null);
  const sequence = jobs
    .map((job, index) => `${index + 1}) №${job.id} «${job.workTypeTitle ?? skillLabel(job.requiredSkill)}»`)
    .join('; ');
  const travelMin = Math.round(route.travelTimeSec / 60);
  const facts = [
    `${engineer.displayName}: навыки ${engineer.skills.map(skillLabel).join(', ') || 'не указаны'}, транспорт ${transportLabel(engineer.transportType)}.`,
    `В маршруте ${route.assignedCount} заявок, пробег ${formatKm(route.distanceKm)}, в пути ${travelMin} мин.`,
    sequence ? `Порядок: ${sequence}.` : 'Рабочих остановок в плане нет.',
    `Политика «${policyTitle(snapshot.policyId)}» задаёт, кого загружать и какой критерий жать после покрытия.`,
  ];
  const first = jobs[0];
  const influence = first
    ? `Первой стоит №${first.id}, потому что после старта смены это ближайший допустимый слот по окну ${formatClock(first.windowStartAt)}–${formatClock(first.windowEndAt)}. Дальше порядок держит уже открытую смену: не плодить новых исполнителей и не растягивать пробег сильнее, чем требует политика.`
    : `Маршрут собран из допустимых окон и доездов этой смены.`;
  return {
    title: `Почему маршрут ${engineer.displayName} такой`,
    facts,
    influence,
    result: `Итог смены: ${route.assignedCount} заявок, ${formatKm(route.distanceKm)}.`,
  };
}

function explainIdleEngineer(snapshot: DashboardSnapshot, engineer: EngineerView): CaseExplanation {
  const leftover = unassignedRequests(snapshot).filter(
    (request) => !request.region || !engineer.region || request.region === engineer.region,
  );
  const leftoverSkills = unique(leftover.map((item) => item.requiredSkill));
  const matching = leftover.filter((request) => engineer.skills.includes(request.requiredSkill));
  const facts = [
    `${engineer.displayName} в зоне ${engineer.region ?? 'без региона'}: навыки ${engineer.skills.map(skillLabel).join(', ') || 'не указаны'}, транспорт ${transportLabel(engineer.transportType)}.`,
    `В плане 0 заявок, пробег 0 км.`,
    leftover.length
      ? `Без назначения в этой зоне ${leftover.length}: ${leftover
          .slice(0, 4)
          .map((item) => `№${item.id} «${skillLabel(item.requiredSkill)}»`)
          .join(', ')}${leftover.length > 4 ? '…' : ''}.`
      : 'Неназначенных заявок в этой зоне нет.',
    `Политика «${policyTitle(snapshot.policyId)}».`,
  ];
  let influence: string;
  if (!leftover.length) {
    influence = 'Остатка работы в зоне нет — открывать эту смену не из чего.';
  } else if (!matching.length) {
    influence = `Свободная смена не берёт остаток: заявки просят ${leftoverSkills.map(skillLabel).join(', ')}, а у ${engineer.displayName} нет этих навыков.`;
  } else if (snapshot.policyId === 'compact') {
    influence = `Навык на ${matching.length} из остатка есть, но «Компактнее» держит работу на уже открытых сменах и не выводит ещё одного человека. Это сознательный обмен: меньше бригад ценой незакрытых заявок.`;
  } else if (snapshot.policyId === 'covering') {
    influence = `Покрывающая политика сначала держит работу на уже открытых сменах, как compact, и только хвост отдаёт новым резервным инженерам. Эта смена осталась пустой, потому что её не потребовалось открывать.`;
  } else {
    influence = `Остаток формально совместим, но текущий поиск не открыл эту смену: выбранная политика сначала жмёт свой критерий на уже занятых маршрутах.`;
  }
  return {
    title: `Почему ${engineer.displayName} без заявок`,
    facts,
    influence,
    result: leftover.length
      ? `${engineer.displayName} простаивает при ${leftover.length} неназначенных в зоне.`
      : `${engineer.displayName} простаивает: в зоне не осталось работы.`,
  };
}

function policyTitle(policyId: PolicyId): string {
  return POLICY_LABELS[policyId] ?? policyId;
}

function engineersInRegion(snapshot: DashboardSnapshot, region: string | null) {
  return snapshot.engineers.filter((item) => !region || !item.region || item.region === region);
}

function idleInRegion(snapshot: DashboardSnapshot, region: string | null) {
  const summaries = new Map(engineerSummaries(snapshot).map((item) => [item.engineerId, item]));
  return engineersInRegion(snapshot, region)
    .map((item) => summaries.get(item.id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined && item.assignedCount === 0);
}

function previousRequest(
  snapshot: DashboardSnapshot,
  route: PlanRouteView | null,
  requestId: string,
): RequestView | null {
  if (!route) {
    return null;
  }
  const jobs = route.stops.filter((stop) => stop.kind === 'job' && stop.requestId);
  const index = jobs.findIndex((stop) => stop.requestId === requestId);
  const previous = index > 0 ? jobs[index - 1] : null;
  return previous?.requestId ? requestById(snapshot, previous.requestId) : null;
}

function inboundTravelSec(route: PlanRouteView, sequence: number): number | null {
  const stop = route.stops.find((item) => item.sequence === sequence);
  if (!stop) {
    return null;
  }
  const incoming = route.legs.find((leg) => {
    const target = route.stops.find((item) => item.sequence === sequence);
    return target !== undefined && leg.arrivalAt === target.arrivalAt;
  });
  return incoming?.travelTimeSec ?? null;
}

function inboundDistanceKm(route: PlanRouteView | null, sequence: number | null): number | null {
  if (!route || sequence === null) {
    return null;
  }
  const stop = route.stops.find((item) => item.sequence === sequence);
  if (!stop) {
    return null;
  }
  const incoming = route.legs.find((leg) => leg.arrivalAt === stop.arrivalAt);
  return incoming?.distanceKm ?? null;
}

function firstFactorFacts(reasons: AssignmentReasons): Record<string, unknown> | undefined {
  return reasons.assignment?.factors[0]?.facts;
}

function numberFromFacts(
  facts: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = facts?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function minutesFromFacts(
  facts: Record<string, unknown> | undefined,
  key: string,
  fallback: number | null,
): number | null {
  const sec = numberFromFacts(facts, key) ?? fallback;
  return sec === null ? null : Math.round(sec / 60);
}

function csv(facts: Record<string, unknown> | undefined, key: string): string[] {
  const value = facts?.[key];
  return typeof value === 'string' && value.length > 0 ? value.split(',').filter(Boolean) : [];
}

function engineerName(snapshot: DashboardSnapshot, id: string): string {
  return snapshot.engineers.find((item) => item.id === id)?.displayName ?? id;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
