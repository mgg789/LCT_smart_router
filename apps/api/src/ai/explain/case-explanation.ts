/**
 * Server-side port of `apps/web/src/lib/explanations.ts#explainSelection`.
 *
 * This is a *port*, not a reimplementation: every branch, string and helper below mirrors
 * the web module line for line, because the two must produce byte-identical
 * `CaseExplanation`s for the same snapshot (AGENTS.md §9.5, D-11, D-3 — the LLM never
 * invents an explanation, and neither does a second, silently-diverging TS copy of this
 * one). `case-explanation.spec.ts` and the web's `explanations.golden.test.ts` both read
 * `docs/contracts/fixtures/case-explanation.golden.json`: a drift between the two builders
 * fails a test on whichever side changed, instead of the two quietly disagreeing about why
 * an assignment happened.
 *
 * The input type here is a *structural subset* of the web's `DashboardSnapshot` and its
 * related view types -- only the fields this builder actually reads. It is declared locally
 * rather than imported from `apps/web` because the two apps are separate packages/deploys;
 * anything assignable to the web's real types (including the golden fixture's JSON,
 * untyped) satisfies this one too.
 */

export interface CaseExplanation {
  readonly title: string;
  readonly facts: string[];
  readonly influence: string;
  readonly result: string;
}

export interface ExplainReasonFactor {
  readonly code?: string;
  readonly facts?: Record<string, unknown>;
}

export interface ExplainAssignmentReasons {
  readonly assignment?: {
    readonly chosen?: string | null;
    readonly factors: readonly ExplainReasonFactor[];
  };
}

export interface ExplainRequestView {
  readonly id: string;
  readonly region: string | null;
  readonly requiredSkill: string;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly serviceDurationSec: number;
  readonly workTypeTitle?: string | null;
}

export interface ExplainEngineerDayView {
  readonly availability: 'online' | 'offline' | 'technical_break';
}

export interface ExplainEngineerView {
  readonly id: string;
  readonly displayName: string;
  readonly skills: readonly string[];
  readonly transportType: string;
  readonly region: string | null;
  readonly day?: ExplainEngineerDayView | null;
}

export interface ExplainPlanStopView {
  readonly sequence: number;
  readonly kind: 'job' | 'lunch' | 'wait' | 'start';
  readonly requestId: string | null;
  readonly arrivalAt: number;
  readonly startAt: number;
  readonly endAt: number;
}

export interface ExplainPlanLegView {
  readonly arrivalAt: number;
  readonly travelTimeSec: number;
  readonly distanceKm: number;
}

export interface ExplainPlanRouteView {
  readonly engineerId: string;
  readonly distanceKm: number;
  readonly travelTimeSec: number;
  readonly assignedCount: number;
  readonly stops: readonly ExplainPlanStopView[];
  readonly legs: readonly ExplainPlanLegView[];
}

export interface ExplainPlanAssignmentView {
  readonly requestId: string;
  readonly status: 'assigned' | 'unassigned' | 'in_progress' | 'done' | 'pending';
  readonly engineerId: string | null;
  readonly reasons: ExplainAssignmentReasons;
}

export type ExplainPolicyId = 'compact' | 'fast' | 'sla' | 'balanced' | 'eco' | 'covering';

export interface ExplainSnapshot {
  readonly policyId: ExplainPolicyId | string;
  readonly engineers: readonly ExplainEngineerView[];
  readonly requests: readonly ExplainRequestView[];
  readonly plan: {
    readonly plan: {
      readonly routes: readonly ExplainPlanRouteView[];
      readonly assignments: readonly ExplainPlanAssignmentView[];
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Labels ported from apps/web/src/lib/reasons.ts -- kept as a private subset:
// this module never invents wording of its own, it only mirrors the same
// finite dictionaries the web dashboard already renders from.
// ---------------------------------------------------------------------------

const SKILL_LABELS: Record<string, string> = {
  local: 'локальные работы',
  connection: 'подключение',
  emergency: 'авария',
};

const TRANSPORT_LABELS: Record<string, string> = {
  car: 'авто',
  walk: 'пешком',
  bike: 'велосипед',
  transit: 'общественный транспорт',
};

const POLICY_LABELS: Record<string, string> = {
  compact: 'Компактнее — меньше инженеров',
  fast: 'Быстрее до клиента',
  sla: 'Бережнее к окнам',
  balanced: 'Ровнее загрузка',
  eco: 'Короче пробег',
  covering: 'Полное покрытие',
};

function skillLabel(skill: string): string {
  return SKILL_LABELS[skill] ?? skill;
}

function transportLabel(transport: string): string {
  return TRANSPORT_LABELS[transport] ?? transport;
}

function policyTitle(policyId: string): string {
  return POLICY_LABELS[policyId] ?? policyId;
}

// ---------------------------------------------------------------------------
// Time formatting ported from apps/web/src/lib/time.ts -- fixed Europe/Moscow
// offset, the same the web dashboard renders every clock with (context/33 §4).
// ---------------------------------------------------------------------------

const MOSCOW_OFFSET_SEC = 3 * 3600;

function formatClock(unixSec: number): string {
  const local = new Date((unixSec + MOSCOW_OFFSET_SEC) * 1000);
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatDurationMin(sec: number): string {
  return `${Math.round(sec / 60)} мин`;
}

function formatKm(km: number): string {
  return `${km.toFixed(km >= 10 ? 0 : 1).replace('.', ',')} км`;
}

// ---------------------------------------------------------------------------
// Reasons normalizer, ported from apps/web/src/api/client.ts#normalizeReasons.
//
// `AppliedPlanAssignment.reasons` is stored exactly as Router sent it: a plain array of
// `{code, text, basis, facts}` (context/11, D-3 -- structured, checkable, never a
// hand-written sentence). The web dashboard normalizes that array into the
// `{assignment: {chosen, factors, alternatives}}` shape `explainSelection` actually reads
// before ever calling it; this server port needs the identical normalization for the same
// stored rows, or its facts-driven lines (travel time, margin, ...) silently go missing.
// ---------------------------------------------------------------------------

export function normalizeAssignmentReasons(
  raw: unknown,
  engineerId: string | null,
): ExplainAssignmentReasons {
  if (Array.isArray(raw)) {
    return {
      assignment: {
        chosen: engineerId,
        factors: raw.flatMap((item) => {
          if (item === null || typeof item !== 'object') {
            return [];
          }
          const record = item as Record<string, unknown>;
          const code = typeof record.code === 'string' ? record.code : undefined;
          if (code === undefined) {
            return [];
          }
          const facts =
            record.facts !== null && typeof record.facts === 'object'
              ? (record.facts as Record<string, unknown>)
              : undefined;
          return [{ code, facts }];
        }),
      },
    };
  }
  if (raw !== null && typeof raw === 'object' && 'assignment' in raw) {
    const assignment = (raw as { assignment?: unknown }).assignment;
    if (assignment !== null && typeof assignment === 'object') {
      const record = assignment as Record<string, unknown>;
      const chosen =
        typeof record.chosen === 'string' ? record.chosen : (record.chosen as null | undefined);
      const factors = Array.isArray(record.factors)
        ? record.factors.flatMap((item) => {
            if (item === null || typeof item !== 'object') {
              return [];
            }
            const factor = item as Record<string, unknown>;
            const code = typeof factor.code === 'string' ? factor.code : undefined;
            if (code === undefined) {
              return [];
            }
            const facts =
              factor.facts !== null && typeof factor.facts === 'object'
                ? (factor.facts as Record<string, unknown>)
                : undefined;
            return [{ code, facts }];
          })
        : [];
      return { assignment: { chosen: chosen ?? engineerId, factors } };
    }
  }
  return { assignment: { chosen: engineerId, factors: [] } };
}

// ---------------------------------------------------------------------------
// Builder, ported from apps/web/src/lib/explanations.ts
// ---------------------------------------------------------------------------

/**
 * Build a dispatcher explanation from the current snapshot, not a stock phrase.
 * Shape is always Facts → Influence → Result (context/11).
 */
export function explainSelection(
  snapshot: ExplainSnapshot,
  request: ExplainRequestView | null,
  assignment: ExplainPlanAssignmentView | null,
  engineer: ExplainEngineerView | null,
  route: ExplainPlanRouteView | null,
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
  snapshot: ExplainSnapshot,
  request: ExplainRequestView,
  assignment: ExplainPlanAssignmentView | null,
  engineer: ExplainEngineerView | null,
  route: ExplainPlanRouteView | null,
): CaseExplanation {
  const chosen = engineer ?? snapshot.engineers.find((item) => item.id === assignment?.engineerId);
  const name = chosen?.displayName ?? 'выбранный инженер';
  const facts = assignment ? firstFactorFacts(assignment.reasons) : undefined;
  const stop = route?.stops.find((item) => item.requestId === request.id);
  const previousJob = previousRequest(snapshot, route, request.id);
  const travelMin = minutesFromFacts(
    facts,
    'travel_time_sec',
    stop && route ? inboundTravelSec(route, stop.sequence) : null,
  );
  const travelKm =
    numberFromFacts(facts, 'distance_km') ?? inboundDistanceKm(route, stop?.sequence ?? null);
  const marginSec = numberFromFacts(facts, 'window_end_margin_sec');
  const margin = marginSec ?? (stop ? request.windowEndAt - stop.startAt : null);
  const sameRegionIdle = idleInRegion(snapshot, request.region).filter(
    (item) => item.id !== chosen?.id,
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
  snapshot: ExplainSnapshot,
  request: ExplainRequestView,
  assignment: ExplainPlanAssignmentView,
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
    influence = `Свободные ${idle.map((item) => item.displayName).join(', ')} не подходят по навыку: заявка просит «${skillLabel(request.requiredSkill)}», у них ${
      unique(idle.flatMap((item) => item.skills))
        .map(skillLabel)
        .join(', ') || 'нет нужных навыков'
    }.`;
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
  snapshot: ExplainSnapshot,
  engineer: ExplainEngineerView,
  route: ExplainPlanRouteView,
): CaseExplanation {
  const jobs = route.stops
    .filter((stop) => stop.kind === 'job' && stop.requestId)
    .map((stop) => requestById(snapshot, stop.requestId as string))
    .filter((item): item is ExplainRequestView => item !== null);
  const sequence = jobs
    .map(
      (job, index) =>
        `${index + 1}) №${job.id} «${job.workTypeTitle ?? skillLabel(job.requiredSkill)}»`,
    )
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

function explainIdleEngineer(
  snapshot: ExplainSnapshot,
  engineer: ExplainEngineerView,
): CaseExplanation {
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

function requestById(snapshot: ExplainSnapshot, requestId: string): ExplainRequestView | null {
  return snapshot.requests.find((item) => item.id === requestId) ?? null;
}

function unassignedRequests(snapshot: ExplainSnapshot): ExplainRequestView[] {
  const plan = snapshot.plan.plan;
  if (!plan) {
    return [];
  }
  const unassignedIds = new Set(
    plan.assignments.filter((item) => item.status === 'unassigned').map((item) => item.requestId),
  );
  return snapshot.requests.filter((item) => unassignedIds.has(item.id));
}

function engineersInRegion(snapshot: ExplainSnapshot, region: string | null) {
  return snapshot.engineers.filter((item) => !region || !item.region || item.region === region);
}

function idleInRegion(snapshot: ExplainSnapshot, region: string | null) {
  return engineersInRegion(snapshot, region).filter((engineer) => {
    const assignedCount =
      snapshot.plan.plan?.assignments.filter(
        (assignment) => assignment.engineerId === engineer.id && assignment.status !== 'unassigned',
      ).length ?? 0;
    return assignedCount === 0;
  });
}

function previousRequest(
  snapshot: ExplainSnapshot,
  route: ExplainPlanRouteView | null,
  requestId: string,
): ExplainRequestView | null {
  if (!route) {
    return null;
  }
  const jobs = route.stops.filter((stop) => stop.kind === 'job' && stop.requestId);
  const index = jobs.findIndex((stop) => stop.requestId === requestId);
  const previous = index > 0 ? jobs[index - 1] : null;
  return previous?.requestId ? requestById(snapshot, previous.requestId) : null;
}

function inboundTravelSec(route: ExplainPlanRouteView, sequence: number): number | null {
  const stop = route.stops.find((item) => item.sequence === sequence);
  if (!stop) {
    return null;
  }
  const incoming = route.legs.find((leg) => leg.arrivalAt === stop.arrivalAt);
  return incoming?.travelTimeSec ?? null;
}

function inboundDistanceKm(
  route: ExplainPlanRouteView | null,
  sequence: number | null,
): number | null {
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

function firstFactorFacts(reasons: ExplainAssignmentReasons): Record<string, unknown> | undefined {
  return reasons.assignment?.factors[0]?.facts;
}

function numberFromFacts(facts: Record<string, unknown> | undefined, key: string): number | null {
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

function engineerName(snapshot: ExplainSnapshot, id: string): string {
  return snapshot.engineers.find((item) => item.id === id)?.displayName ?? id;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}
