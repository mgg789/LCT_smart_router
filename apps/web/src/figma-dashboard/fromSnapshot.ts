import type { DispatchLiveView, HandoffView, LiveBreak } from '../api/live';
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
import { t } from '../i18n';
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
  number: t('figma-dashboard.fromSnapshot.255f2a4738'),
  title: t('figma-dashboard.fromSnapshot.b02db5971a'),
  tags: [t('figma-dashboard.fromSnapshot.94a31bf356')],
  company: t('figma-dashboard.fromSnapshot.e15552105f'),
  address: t('figma-dashboard.fromSnapshot.7d3fcb4fe2'),
  window: '—',
  work: t('figma-dashboard.fromSnapshot.19cde6dad4'),
  whyTitle: t('figma-dashboard.fromSnapshot.ec4f706a09'),
  reasons: [
    { icon: 'reasonCheck', label: t('figma-dashboard.fromSnapshot.d32fd39489') },
    { icon: 'reasonCar', label: t('figma-dashboard.fromSnapshot.94edff44b2') },
    { icon: 'reasonClock', label: t('figma-dashboard.fromSnapshot.f3c0cfc4ab') },
    { icon: 'reasonPin', label: t('figma-dashboard.fromSnapshot.caeef48328') },
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
    metroEnabled: current?.metroEnabled ?? false,
    strictTimeWindows: current?.strictTimeWindows ?? true,
    departureLatenessToleranceSec: current?.departureLatenessToleranceSec ?? 0,
    taskStartLatenessToleranceSec: current?.taskStartLatenessToleranceSec ?? 0,
    windowLatenessToleranceSec: current?.windowLatenessToleranceSec ?? 0,
    trafficEnabled: current?.trafficEnabled ?? false,
    equipmentEnabled: current?.equipmentEnabled ?? true,
    equipmentTransfersEnabled: current?.equipmentTransfersEnabled ?? false,
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
    planLabel: t('figma-dashboard.fromSnapshot.a11d091038', {
      value0: unassigned.length,
      value1: formatClock(planAsOf),
    }),
    unassignedTitle: unassignedCountTitle(unassigned.length),
    unassignedReason: unassignedBannerReason(firstUnassignedAssignment, firstUnassigned),
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
        place: t('figma-dashboard.fromSnapshot.15ac3e38fe'),
        status:
          item.endedAt === null
            ? t('figma-dashboard.fromSnapshot.66e004d65b', {
                value0: formatClock(item.plannedEndAt),
              })
            : t('figma-dashboard.fromSnapshot.f40eba382c'),
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
            ? t('figma-dashboard.fromSnapshot.422d4c8ff1')
            : node.kind === 'lunch'
              ? t('figma-dashboard.fromSnapshot.69a29fbff8')
              : node.kind === 'handoff'
                ? t('figma-dashboard.fromSnapshot.31f207a99a')
                : node.kind === 'delivery'
                  ? t('figma-dashboard.fromSnapshot.abbe1ea907')
                  : node.kind === 'office_pickup'
                    ? t('figma-dashboard.fromSnapshot.238a113959')
                    : request
                      ? routeStopAddress(request.addressText)
                      : t('figma-dashboard.fromSnapshot.77b3e0166b'),
        status:
          node.kind === 'start'
            ? state?.lineStartedAt
              ? t('figma-dashboard.fromSnapshot.0cb57c23be')
              : state?.noShowAt
                ? t('figma-dashboard.fromSnapshot.72b8248551')
                : t('figma-dashboard.fromSnapshot.c79dabf212')
            : node.kind === 'lunch'
              ? t('figma-dashboard.fromSnapshot.c0f7d29eab')
              : node.kind === 'handoff'
                ? handoffStatus(live?.handoffs ?? [], node.handoffId, state?.id)
                : node.kind === 'delivery' || node.kind === 'office_pickup'
                  ? t('figma-dashboard.fromSnapshot.2505cac3d2')
                  : stopStatus(request),
        active: node.kind !== 'start' && graph.activeNodeKeys.has(node.key),
        failed: node.kind === 'start' && Boolean(state?.noShowAt),
        completed:
          node.kind === 'start'
            ? entered
            : node.kind === 'handoff'
              ? Boolean(live?.handoffs.find((item) => item.id === node.handoffId)?.completedAt)
              : request?.lifecycle === 'completed' || Boolean(request?.assumedCompletedAt),
        handoffId: node.handoffId ?? undefined,
        handoff: node.handoffId
          ? live?.handoffs.find((item) => item.id === node.handoffId)
          : undefined,
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
            ? t('figma-dashboard.fromSnapshot.8a09723017')
            : item.outcome === 'assumed_completed'
              ? t('figma-dashboard.fromSnapshot.51ec8d5076')
              : t('figma-dashboard.fromSnapshot.f40eba382c'),
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
        place: t('figma-dashboard.fromSnapshot.69a29fbff8'),
        status:
          now >= endAt
            ? t('figma-dashboard.fromSnapshot.f40eba382c')
            : t('figma-dashboard.fromSnapshot.c0f7d29eab'),
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
      (stop) =>
        stop.kind === 'job' &&
        !stop.completed &&
        stop.status !== t('figma-dashboard.fromSnapshot.8a09723017'),
    ).length;
    return {
      ...engineer,
      stops,
      doneCount,
      requestCount: doneCount + remaining,
      lineLabel:
        state?.lineStatus === 'no_show_offline'
          ? state.lineStartedAt
            ? t('figma-dashboard.fromSnapshot.fedfda3fb7')
            : t('figma-dashboard.fromSnapshot.bfab9f3069')
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
    transportType: summary.transportType,
    status: transportLabel(summary.transportType),
    shift:
      summary.shiftStartAt && summary.shiftEndAt
        ? `${formatClock(summary.shiftStartAt)}-${formatClock(summary.shiftEndAt)}`
        : t('figma-dashboard.fromSnapshot.8a998b0216'),
    requestCount: summary.assignedCount,
    doneCount: summary.doneCount,
    routeUpdated: t('figma-dashboard.fromSnapshot.f5f57efff6', { value0: formatClock(planAsOf) }),
    stops: routeStopsFromRoute(snapshot, route),
    request: request
      ? requestPanelFromSnapshot(request, assignment, explanation?.title ?? null)
      : {
          ...EMPTY_REQUEST,
          whyTitle: t('figma-dashboard.fromSnapshot.7c092982ec', {
            value0: summary.displayName.split(' ')[0] ?? '',
          }).trim(),
        },
    primaryRequestId: request?.id,
  };
}

function handoffStatus(
  handoffs: readonly HandoffView[],
  handoffId: string | null | undefined,
  engineerId: string | undefined,
): string {
  const handoff = handoffs.find((item) => item.id === handoffId);
  if (!handoff) return t('figma-dashboard.fromSnapshot.cfd07ab768');
  if (handoff.completedAt !== null) return t('figma-dashboard.fromSnapshot.f40eba382c');
  if (
    (engineerId === handoff.donorEngineerId && handoff.donorConfirmedAt !== null) ||
    (engineerId === handoff.receiverEngineerId && handoff.receiverConfirmedAt !== null)
  ) {
    return t('figma-dashboard.fromSnapshot.4acb9f2702');
  }
  return engineerId === handoff.donorEngineerId
    ? t('figma-dashboard.fromSnapshot.1dc58eaa3a')
    : t('figma-dashboard.fromSnapshot.9659ad64c2');
}

function requestPanelFromSnapshot(
  request: RequestView,
  assignment: PlanAssignmentView | null,
  whyTitle: string | null,
): EngineerRequest {
  const skill = request.requiredSkill ? skillLabel(request.requiredSkill) : null;
  const tags = [
    request.workTypeTitle,
    request.priority === 'urgent' ? t('figma-dashboard.fromSnapshot.7d27aa7f9c') : null,
    skill && skill !== request.workTypeTitle ? skill : null,
  ].filter((item): item is string => Boolean(item));
  return {
    number: t('figma-dashboard.fromSnapshot.80b3e93473', { value0: shortRequestId(request.id) }),
    title: request.workTypeTitle ?? t('figma-dashboard.fromSnapshot.77b3e0166b'),
    tags: tags.slice(0, 2),
    company: request.contactName ?? t('figma-dashboard.fromSnapshot.3e622aecbf'),
    address: shortAddress(request.addressText),
    window: `${formatClock(request.windowStartAt)}-${formatClock(request.windowEndAt)}`,
    work: request.workTypeTitle ?? formatDurationMin(request.serviceDurationSec),
    whyTitle:
      whyTitle ??
      (assignment?.status === 'unassigned'
        ? t('figma-dashboard.fromSnapshot.9da41e73a4')
        : t('figma-dashboard.fromSnapshot.d1a6f2cb24')),
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
      place: t('figma-dashboard.fromSnapshot.69a29fbff8'),
      status: t('figma-dashboard.fromSnapshot.c0f7d29eab'),
      requestId: null,
      kind: 'lunch',
      at: stop.startAt,
    };
  }
  if (stop.kind === 'start') {
    return {
      time: formatClock(stop.startAt),
      place: t('figma-dashboard.fromSnapshot.ae64d5c267'),
      status: t('figma-dashboard.fromSnapshot.ddf53b03c7'),
      requestId: null,
      kind: 'start',
      at: stop.startAt,
    };
  }
  if (stop.kind === 'delivery' || stop.kind === 'office_pickup') {
    return {
      time: formatClock(stop.startAt),
      place:
        stop.kind === 'delivery'
          ? t('figma-dashboard.fromSnapshot.abbe1ea907')
          : t('figma-dashboard.fromSnapshot.238a113959'),
      status: t('figma-dashboard.fromSnapshot.2505cac3d2'),
      requestId: null,
      kind: stop.kind,
      at: stop.startAt,
    };
  }
  if (stop.kind === 'handoff') {
    return {
      time: formatClock(stop.startAt),
      place: t('figma-dashboard.fromSnapshot.31f207a99a'),
      status: t('figma-dashboard.fromSnapshot.cfd07ab768'),
      requestId: null,
      kind: 'handoff',
      handoffId: stop.handoff?.handoff_id,
      at: stop.startAt,
    };
  }
  const request = stop.requestId ? requestById(snapshot, stop.requestId) : null;
  return {
    time: formatClock(stop.startAt),
    place: request
      ? routeStopAddress(request.addressText)
      : t('figma-dashboard.fromSnapshot.77b3e0166b'),
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
  label: string;
  tone: 'neutral' | 'urgent' | 'emergency';
} {
  if (request.requiredSkill === 'emergency') {
    return { label: t('figma-dashboard.fromSnapshot.c543fd76ec'), tone: 'emergency' };
  }
  if (request.priority === 'urgent') {
    return { label: t('figma-dashboard.fromSnapshot.7d27aa7f9c'), tone: 'urgent' };
  }
  return { label: t('figma-dashboard.fromSnapshot.633208f96e'), tone: 'neutral' };
}

function stopStatus(request: RequestView | null): string {
  if (!request) return t('figma-dashboard.fromSnapshot.94096c9f49');
  if (request.lifecycle === 'cancelled') return t('figma-dashboard.fromSnapshot.8a09723017');
  if (request.assumedCompletedAt) return t('figma-dashboard.fromSnapshot.51ec8d5076');
  if (request.lifecycle === 'completed' || request.assignmentState === 'done')
    return t('figma-dashboard.fromSnapshot.f40eba382c');
  if (request.lifecycle === 'in_progress') return t('figma-dashboard.fromSnapshot.775f97e371');
  return t('figma-dashboard.fromSnapshot.94096c9f49');
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

/**
 * Second line of the unassigned banner. It is always a reason: an address is a
 * place, and showing it here made a missing plan look like a located visit.
 */
function unassignedBannerReason(
  assignment: ReturnType<typeof assignmentFor>,
  request: RequestView | null,
): string {
  const code = assignment?.reasons.assignment?.factors[0]?.code;
  if (code) return factorLabel(code);
  if (!request) return t('figma-dashboard.fromSnapshot.a1c1218974');
  if (!assignment) return t('figma-dashboard.fromSnapshot.f05f481c05');
  return t('figma-dashboard.fromSnapshot.abc45d9d14');
}

function unassignedCountTitle(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11)
    return t('figma-dashboard.fromSnapshot.424fee003a', { value0: count });
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return t('figma-dashboard.fromSnapshot.860276a056', { value0: count });
  return t('figma-dashboard.fromSnapshot.951723d625', { value0: count });
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
