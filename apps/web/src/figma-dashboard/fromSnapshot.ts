import type { DispatchLiveView, LiveBreak } from '../api/live';
import type {
  AlertView,
  DashboardSnapshot,
  PlanAssignmentView,
  PlanRouteView,
  PlanStopView,
  PolicyId,
  RequestView,
  RouterTechnicalSettings,
} from '../api/types';
import {
  assignmentFor,
  type EngineerSummary,
  engineerSummaries,
  requestById,
  routeForEngineer,
  unassignedRequests,
} from '../domain/dashboard';
import { projectLiveGraph } from '../domain/liveGraph';
import { explainSelection } from '../lib/explanations';
import { factorLabel, POLICY_LABELS, skillLabel, transportLabel } from '../lib/reasons';
import { formatClock, formatDayTitle, formatDurationMin } from '../lib/time';
import {
  type DashboardNotification,
  type EngineerCard,
  type EngineerRequest,
  type NotificationIconKey,
  type NotificationTone,
  type ReasonIconKey,
  type RouteStop,
  visibleNotifications,
} from './fixtures';
import { shortRequestId } from './requestsTable';

const REASON_ICON_ORDER = [
  'reasonCheck',
  'reasonCar',
  'reasonClock',
  'reasonPin',
] as const satisfies readonly ReasonIconKey[];

const EMPTY_REQUEST: EngineerRequest = {
  number: 'План дня',
  title: 'Все маршруты',
  tags: ['Общий план'],
  company: 'Выберите заявку',
  address: 'На карте все смены',
  window: '—',
  work: 'Клик по инженеру или точке',
  whyTitle: 'Почему этот план?',
  reasons: [
    { icon: 'reasonCheck', label: 'Навык, транспорт и окна в расчёте' },
    { icon: 'reasonCar', label: 'Совместимость техники проверена' },
    { icon: 'reasonClock', label: 'Слоты внутри клиентских окон' },
    { icon: 'reasonPin', label: 'Доезды из матрицы маршрута' },
  ],
};

/**
 * Dispatcher date in the Figma header: "15 сентября, 2026".
 */
export function figmaDateLabel(workDate: string): string {
  return formatDayTitle(workDate).replace(/ (\d{4})$/, ', $1');
}

/**
 * Policy chip label. Prefers the live catalog title, then the shared dictionary.
 */
export function policyLabel(policyId: PolicyId, title?: string): string {
  return POLICY_LABELS[policyId] ?? title ?? policyId;
}

/**
 * Router settings for a policy/lunch/traffic edit without dropping other fields.
 */
export function nextRouterSettings(
  snapshot: DashboardSnapshot,
  patch: Partial<RouterTechnicalSettings>,
): RouterTechnicalSettings {
  const current = snapshot.routerSettings;
  return {
    lunchesEnabled: snapshot.lunchesEnabled,
    departureLatenessToleranceSec: current?.departureLatenessToleranceSec ?? 0,
    taskStartLatenessToleranceSec: current?.taskStartLatenessToleranceSec ?? 0,
    windowLatenessToleranceSec: current?.windowLatenessToleranceSec ?? 0,
    trafficEnabled: current?.trafficEnabled ?? false,
    equipmentEnabled: current?.equipmentEnabled ?? true,
    travelTimeMode: current?.travelTimeMode ?? 'graph_with_access_buffer',
    accessBufferSec: current?.accessBufferSec ?? 600,
    fixedTravelTimeSec: current?.fixedTravelTimeSec ?? 900,
    earlyFinishReplanThresholdSec: current?.earlyFinishReplanThresholdSec ?? 0,
    taskOverrunToleranceSec: current?.taskOverrunToleranceSec ?? 0,
    routerContextVersion: snapshot.routerContextVersion,
    ...patch,
  };
}

/**
 * Maps an open alert to a header-dropdown card.
 */
export function notificationFromAlert(alert: AlertView): DashboardNotification {
  return {
    id: alert.id,
    tone: alert.severity === 'info' ? 'plain' : 'yellow',
    icon: notificationIcon(alert.code),
    text: alert.reasons[0] ?? factorLabel(alert.code),
  };
}

/**
 * Open alerts for the bell: unseen first, at most three cards, badge = open count.
 */
export function notificationsFromSnapshot(snapshot: DashboardSnapshot): {
  count: number;
  tone: NotificationTone;
  items: DashboardNotification[];
} {
  const open = snapshot.alerts.filter((alert) => alert.resolvedAt === null);
  const items = visibleNotifications(open.map(notificationFromAlert));
  return {
    count: open.length,
    tone: open.some((alert) => alert.severity !== 'info') ? 'yellow' : 'gray',
    items,
  };
}

/**
 * Right-hand Figma panel: plan (brigade card) or request (map/topic). Hidden otherwise.
 */
export function rightPanelMode(
  engineerId: string | null,
  requestId: string | null,
): 'plan' | 'request' | null {
  if (requestId) return 'request';
  if (engineerId) return 'plan';
  return null;
}

/**
 * Engineer roster + selected request/route for the Figma MAIN slots.
 */
export function dashboardViewFromSnapshot(
  snapshot: DashboardSnapshot,
  focus: { engineerId: string | null; requestId: string | null },
): {
  dateLabel: string;
  requestCount: number;
  planLabel: string;
  unassignedTitle: string;
  unassignedReason: string;
  firstUnassignedId: string | null;
  engineers: EngineerCard[];
  totalKm: number;
  displayedEngineerId: string | null;
  displayedRequest: EngineerRequest;
} {
  const summaries = engineerSummaries(snapshot);
  const unassigned = unassignedRequests(snapshot);
  const planAsOf = snapshot.plan.plan?.planAsOf ?? snapshot.nowAt;
  const firstUnassigned = unassigned[0] ?? null;
  const firstUnassignedAssignment = firstUnassigned
    ? assignmentFor(snapshot, firstUnassigned.id)
    : null;
  const engineers = summaries.map((summary) =>
    engineerCardFromSummary(snapshot, summary, planAsOf),
  );
  const displayedEngineerId =
    focus.engineerId ??
    engineers.find((item) => item.requestCount > 0)?.id ??
    engineers[0]?.id ??
    null;
  const focusRequest = focus.requestId ? requestById(snapshot, focus.requestId) : null;
  const fallbackRequest = displayedEngineerId
    ? firstAssignedRequest(snapshot, displayedEngineerId)
    : (snapshot.requests[0] ?? null);
  const request = focusRequest ?? fallbackRequest;
  const assignment = request ? assignmentFor(snapshot, request.id) : null;
  const ownerId = assignment?.engineerId ?? displayedEngineerId;
  const engineer = ownerId
    ? (snapshot.engineers.find((item) => item.id === ownerId) ?? null)
    : null;
  const route = ownerId ? routeForEngineer(snapshot, ownerId) : null;
  const explanation = explainSelection(snapshot, request, assignment, engineer, route);

  return {
    dateLabel: figmaDateLabel(snapshot.workDate),
    requestCount: snapshot.requests.length,
    planLabel: `${unassigned.length} без назначения - план от ${formatClock(planAsOf)}`,
    unassignedTitle: unassignedCountTitle(unassigned.length),
    unassignedReason: firstUnassignedAssignment?.reasons.assignment?.factors[0]?.code
      ? factorLabel(firstUnassignedAssignment.reasons.assignment.factors[0].code)
      : firstUnassigned
        ? (firstUnassigned.workTypeTitle ?? firstUnassigned.addressText)
        : 'Все заявки назначены',
    firstUnassignedId: firstUnassigned?.id ?? null,
    engineers,
    totalKm: engineers.reduce((sum, item) => sum + item.km, 0),
    displayedEngineerId,
    displayedRequest: request
      ? requestPanelFromSnapshot(request, assignment, explanation?.title ?? null)
      : EMPTY_REQUEST,
  };
}

/** Adds durable technical-stop markers to the Figma route strip without
 * replacing Router-owned job and lunch stops. */
export function withTechnicalBreaks(
  engineers: readonly EngineerCard[],
  breaks: readonly LiveBreak[],
): EngineerCard[] {
  return engineers.map((engineer) => {
    const markers: RouteStop[] = breaks
      .filter((item) => item.engineerId === engineer.id)
      .map((item) => ({
        time: formatClock(item.startedAt),
        place: 'Техническая остановка',
        status: item.endedAt === null ? `до ${formatClock(item.plannedEndAt)}` : 'выполнено',
        kind: 'technical' as const,
        at: item.startedAt,
      }));
    if (markers.length === 0) return engineer;
    return {
      ...engineer,
      stops: [...engineer.stops, ...markers].sort((left, right) =>
        left.kind === 'start' ? -1 : right.kind === 'start' ? 1 : (left.at ?? 0) - (right.at ?? 0),
      ),
    };
  });
}

/** Uses the same factual graph as the map, retaining terminal visits across replans. */
export function withLiveRouteStops(
  engineers: readonly EngineerCard[],
  snapshot: DashboardSnapshot,
  live: DispatchLiveView | null,
): EngineerCard[] {
  const cards = engineers.map((engineer) => {
    const state = live?.engineers.find((item) => item.id === engineer.id);
    const graph = projectLiveGraph(
      routeForEngineer(snapshot, engineer.id),
      state?.progress ?? null,
    );
    const history = live?.history.filter((item) => item.engineerId === engineer.id) ?? [];
    const stops: RouteStop[] = graph.timelineNodes.map((node) => {
      const terminal = history.find((item) => item.request.id === node.requestId);
      const request =
        terminal?.request ?? (node.requestId ? requestById(snapshot, node.requestId) : null);
      const entered = state?.lineStatus === 'online' || state?.lineStatus === 'technical_break';
      return {
        kind: node.kind,
        requestId: node.requestId,
        at:
          node.kind === 'start'
            ? (state?.lineStartedAt ?? state?.noShowAt ?? live?.workday.logicalStartAt ?? node.at)
            : node.at,
        time: formatClock(
          node.kind === 'start'
            ? (state?.lineStartedAt ?? state?.noShowAt ?? live?.workday.logicalStartAt ?? node.at)
            : node.at,
        ),
        place:
          node.kind === 'start'
            ? 'Выход на смену'
            : node.kind === 'lunch'
              ? 'Обед'
              : request
                ? routeStopAddress(request.addressText)
                : 'Заявка',
        status:
          node.kind === 'start'
            ? state?.lineStartedAt
              ? 'ВЫШЕЛ'
              : state?.noShowAt
                ? 'НЕ ВЫШЕЛ'
                : 'ожидаем выхода'
            : node.kind === 'lunch'
              ? 'обед'
              : stopStatus(request),
        active: node.kind !== 'start' && graph.activeNodeKeys.has(node.key),
        failed: node.kind === 'start' && Boolean(state?.noShowAt),
        completed:
          node.kind === 'start'
            ? entered
            : request?.lifecycle === 'completed' || Boolean(request?.assumedCompletedAt),
      };
    });
    for (const item of history) {
      const previous = stops.find((stop) => stop.requestId === item.request.id);
      const at = item.request.startedAt ?? item.stop?.startAt ?? item.terminalAt;
      const terminalStop: RouteStop = {
        kind: 'job',
        requestId: item.request.id,
        at,
        time: formatClock(at),
        place: routeStopAddress(item.request.addressText),
        status:
          item.outcome === 'cancelled'
            ? 'отменено'
            : item.outcome === 'assumed_completed'
              ? 'по расписанию'
              : 'выполнено',
        completed: item.outcome !== 'cancelled',
      };
      if (previous) Object.assign(previous, terminalStop);
      else stops.push(terminalStop);
    }
    if (state?.lunchInterval) {
      const { startAt, endAt } = state.lunchInterval;
      const now = live?.workday.liveNow ?? 0;
      const lunch: RouteStop = {
        kind: 'lunch',
        requestId: null,
        at: startAt,
        time: formatClock(startAt),
        place: 'Обед',
        status: now >= endAt ? 'выполнено' : 'обед',
        active: now >= startAt && now < endAt,
        completed: now >= endAt,
      };
      const planned = stops.find((stop) => stop.kind === 'lunch');
      if (planned) Object.assign(planned, lunch);
      else stops.push(lunch);
    }
    stops.sort((a, b) =>
      a.kind === 'start' ? -1 : b.kind === 'start' ? 1 : (a.at ?? 0) - (b.at ?? 0),
    );
    const doneCount = state
      ? state.stats.completedCount + state.stats.assumedCompletedCount
      : engineer.doneCount;
    const remaining = stops.filter(
      (stop) => stop.kind === 'job' && !stop.completed && stop.status !== 'отменено',
    ).length;
    return {
      ...engineer,
      stops,
      doneCount,
      requestCount: doneCount + remaining,
      lineLabel:
        state?.lineStatus === 'no_show_offline'
          ? state.lineStartedAt
            ? 'Снят со смены'
            : 'Не вышел'
          : undefined,
      lineFailed: state?.lineStatus === 'no_show_offline',
    };
  });
  return withTechnicalBreaks(cards, live?.breaks ?? []);
}

function engineerCardFromSummary(
  snapshot: DashboardSnapshot,
  summary: EngineerSummary,
  planAsOf: number,
): EngineerCard {
  const route = routeForEngineer(snapshot, summary.engineerId);
  const request = firstAssignedRequest(snapshot, summary.engineerId);
  const assignment = request ? assignmentFor(snapshot, request.id) : null;
  const engineer = snapshot.engineers.find((item) => item.id === summary.engineerId) ?? null;
  const explanation = explainSelection(snapshot, request, assignment, engineer, route);
  return {
    id: summary.engineerId,
    name: summary.displayName,
    km: Math.round(summary.distanceKm),
    status: transportLabel(summary.transportType),
    shift:
      summary.shiftStartAt && summary.shiftEndAt
        ? `${formatClock(summary.shiftStartAt)}-${formatClock(summary.shiftEndAt)}`
        : 'смена не задана',
    requestCount: summary.assignedCount,
    doneCount: summary.doneCount,
    routeUpdated: `план обновлён в ${formatClock(planAsOf)}`,
    stops: routeStopsFromRoute(snapshot, route),
    request: request
      ? requestPanelFromSnapshot(request, assignment, explanation?.title ?? null)
      : {
          ...EMPTY_REQUEST,
          whyTitle: `Смена ${summary.displayName.split(' ')[0] ?? ''}`.trim(),
        },
    primaryRequestId: request?.id,
  };
}

function requestPanelFromSnapshot(
  request: RequestView,
  assignment: PlanAssignmentView | null,
  whyTitle: string | null,
): EngineerRequest {
  const skill = request.requiredSkill ? skillLabel(request.requiredSkill) : null;
  const tags = [
    request.workTypeTitle,
    request.priority === 'urgent' ? 'Срочная' : null,
    skill && skill !== request.workTypeTitle ? skill : null,
  ].filter((item): item is string => Boolean(item));
  return {
    number: `Заявка № ${shortRequestId(request.id)}`,
    title: request.workTypeTitle ?? 'Заявка',
    tags: tags.slice(0, 2),
    company: request.contactName ?? 'Клиент',
    address: shortAddress(request.addressText),
    window: `${formatClock(request.windowStartAt)}-${formatClock(request.windowEndAt)}`,
    work: request.workTypeTitle ?? formatDurationMin(request.serviceDurationSec),
    whyTitle:
      whyTitle ??
      (assignment?.status === 'unassigned' ? 'Почему без назначения' : 'Почему этот инженер?'),
    reasons: reasonsFromAssignment(assignment),
  };
}

function reasonsFromAssignment(assignment: PlanAssignmentView | null): EngineerRequest['reasons'] {
  const factors = assignment?.reasons.assignment?.factors.slice(0, 4) ?? [];
  if (factors.length > 0) {
    return factors.map((factor, index) => ({
      icon: iconForFactor(factor.code, index),
      label: factorLabel(factor.code),
    }));
  }
  return EMPTY_REQUEST.reasons;
}

function routeStopsFromRoute(
  snapshot: DashboardSnapshot,
  route: PlanRouteView | null,
): RouteStop[] {
  if (!route) return [];
  return route.stops
    .filter((stop) => stop.kind !== 'wait')
    .map((stop) => stopToCard(snapshot, stop));
}

function stopToCard(snapshot: DashboardSnapshot, stop: PlanStopView): RouteStop {
  if (stop.kind === 'lunch') {
    return {
      time: formatClock(stop.startAt),
      place: 'Обед',
      status: 'обед',
      requestId: null,
      kind: 'lunch',
      at: stop.startAt,
    };
  }
  if (stop.kind === 'start') {
    return {
      time: formatClock(stop.startAt),
      place: 'Старт смены',
      status: 'старт смены',
      requestId: null,
      kind: 'start',
      at: stop.startAt,
    };
  }
  const request = stop.requestId ? requestById(snapshot, stop.requestId) : null;
  return {
    time: formatClock(stop.startAt),
    place: request ? routeStopAddress(request.addressText) : 'Заявка',
    status: stopStatus(request),
    requestId: stop.requestId,
    kind: 'job',
    at: stop.startAt,
  };
}

/**
 * Street address for a route topic: no work-type prefix, city prefix dropped.
 */
export function routeStopAddress(address: string): string {
  return address.replace(/^Город\s+[^,]+,\s*/i, '').trim() || address;
}

/**
 * Dispatcher urgency chip. Emergency skill is the only third signal in the contract.
 */
export function requestUrgency(request: Pick<RequestView, 'priority' | 'requiredSkill'>): {
  label: 'Базовая' | 'Срочная' | 'Экстренная';
  tone: 'neutral' | 'urgent' | 'emergency';
} {
  if (request.requiredSkill === 'emergency') {
    return { label: 'Экстренная', tone: 'emergency' };
  }
  if (request.priority === 'urgent') {
    return { label: 'Срочная', tone: 'urgent' };
  }
  return { label: 'Базовая', tone: 'neutral' };
}

function stopStatus(request: RequestView | null): string {
  if (!request) return 'запланировано';
  if (request.lifecycle === 'cancelled') return 'отменено';
  if (request.assumedCompletedAt) return 'по расписанию';
  if (request.lifecycle === 'completed' || request.assignmentState === 'done') return 'выполнено';
  if (request.lifecycle === 'in_progress') return 'сейчас - визит';
  return 'запланировано';
}

function firstAssignedRequest(snapshot: DashboardSnapshot, engineerId: string): RequestView | null {
  const route = routeForEngineer(snapshot, engineerId);
  const job = route?.stops.find((stop) => stop.kind === 'job' && stop.requestId);
  if (job?.requestId) {
    return requestById(snapshot, job.requestId);
  }
  const assignment = snapshot.plan.plan?.assignments.find(
    (item) => item.engineerId === engineerId && item.status !== 'unassigned',
  );
  return assignment ? requestById(snapshot, assignment.requestId) : null;
}

function unassignedCountTitle(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} заявка без назначения`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return `${count} заявки без назначения`;
  return `${count} заявок без назначения`;
}

function shortAddress(address: string): string {
  const parts = address
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 2) return address;
  return parts.slice(-2).join(', ');
}

function notificationIcon(code: string): NotificationIconKey {
  const upper = code.toUpperCase();
  if (upper.includes('UNASSIGNED') || upper.includes('SKILL') || upper.includes('LATE')) {
    return 'delay';
  }
  if (
    upper.includes('PLAN') ||
    upper.includes('ROUTE') ||
    upper.includes('POLICY') ||
    upper.includes('LUNCH')
  ) {
    return 'route';
  }
  return 'message';
}

function iconForFactor(code: string, index: number): ReasonIconKey {
  const lower = code.toLowerCase();
  if (lower.includes('skill') || lower.includes('constraint')) return 'reasonCheck';
  if (lower.includes('equip') || lower.includes('transport') || lower.includes('car'))
    return 'reasonCar';
  if (
    lower.includes('window') ||
    lower.includes('sla') ||
    lower.includes('lunch') ||
    lower.includes('clock')
  ) {
    return 'reasonClock';
  }
  if (lower.includes('travel') || lower.includes('cluster') || lower.includes('pin'))
    return 'reasonPin';
  return REASON_ICON_ORDER[index % REASON_ICON_ORDER.length] ?? 'reasonCheck';
}
