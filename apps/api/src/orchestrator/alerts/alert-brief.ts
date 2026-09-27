import { addEngineerCandidates } from '../../ai/alerts/alert-candidates';
import { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../../persistence';
import type { RouterClient } from '../../routing/router-gateway/router-client.port';
import {
  decisionState,
  moscowClock,
  regionLabel,
  skillLabel,
  tomorrowCrewLine,
} from './alert-decision-context';
import { type AlertAction, alertActionsFor } from './alert-policy';

/**
 * Facts and the full catalogue for one System one call.
 * Window search runs first. A missing slot drops only the window action.
 */
export async function buildAlertBrief(
  prisma: PrismaService,
  proposeWindow: (
    id: string,
  ) => Promise<Awaited<ReturnType<RouterClient['proposeWindow']>> & { requestVersion: number }>,
  alert: {
    id: string;
    code: string;
    reasons: unknown;
    requestIds: string[];
    engineerIds: string[];
    workDate: string | null;
  },
): Promise<{
  summary: string;
  actions: AlertAction[];
  engineers: { id: string; label: string; facts: string }[];
  windows: { label: string; windowStartAt: number; windowEndAt: number; facts: string }[];
  requestVersion: number | null;
  minutes: number[];
}> {
  const request = alert.requestIds[0]
    ? await prisma.request.findUnique({ where: { id: alert.requestIds[0] } })
    : null;
  const catalogue = alertActionsFor(alert.code).filter(
    (action) =>
      request?.workCategory !== 'emergency' ||
      (action !== 'reschedule' && action !== 'move_window'),
  );

  let requestVersion: number | null = null;
  let slots: Array<{
    engineerId: string;
    windowStartAt: number;
    windowEndAt: number;
    neighborRequestIds: readonly string[];
    slackSec: number;
  }> = [];
  if (catalogue.includes('move_window')) {
    try {
      const offer = await proposeWindow(alert.id);
      requestVersion = offer.requestVersion;
      const list =
        offer.proposals && offer.proposals.length > 0
          ? offer.proposals
          : offer.proposal
            ? [offer.proposal]
            : [];
      slots = list.slice(0, 8).map((item) => ({
        engineerId: item.engineerId,
        windowStartAt: item.windowStartAt,
        windowEndAt: item.windowEndAt,
        neighborRequestIds: item.neighborRequestIds ?? [],
        slackSec: item.slackSec ?? 0,
      }));
    } catch {
      slots = [];
    }
  }
  const actions = catalogue.filter((item) => item !== 'move_window' || slots.length > 0);
  const roster = await prisma.engineer.findMany({
    where: { archivedAt: null },
    include: { days: { where: { workDate: alert.workDate ?? '' }, take: 1 } },
  });
  const eligible = addEngineerCandidates(alert.engineerIds, request, roster)
    .slice()
    .sort((left, right) => left.displayName.localeCompare(right.displayName, 'ru'))
    .slice(0, 8);
  const current = await prisma.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } });
  const routes = current
    ? await prisma.appliedPlanRoute.findMany({
        where: { planId: current.planId },
        select: { engineerId: true, assignedCount: true, workTimeSec: true },
      })
    : [];
  const load = new Map(routes.map((route) => [route.engineerId, route]));
  const neighborIds = [...new Set(slots.flatMap((slot) => slot.neighborRequestIds))].slice(0, 24);
  const neighbors = neighborIds.length
    ? await prisma.request.findMany({
        where: { id: { in: neighborIds } },
        select: { id: true, addressText: true, windowStartAt: true, windowEndAt: true },
      })
    : [];
  const neighborText = new Map(
    neighbors.map((item) => [
      item.id,
      `${item.addressText} ${moscowClock(Number(item.windowStartAt))}–${moscowClock(Number(item.windowEndAt))}`,
    ]),
  );
  const people = new Map(roster.map((item) => [item.id, item.displayName]));
  const windows = slots.map((slot, index) => {
    const name = people.get(slot.engineerId) ?? slot.engineerId;
    const beside =
      slot.neighborRequestIds.length > 0
        ? slot.neighborRequestIds.map((item) => neighborText.get(item) ?? item).join('; ')
        : 'соседних заявок нет';
    const route = load.get(slot.engineerId);
    const facts = `${name}, запас ${Math.round(slot.slackSec / 60)} мин, заявок в маршруте ${route?.assignedCount ?? 0}. Рядом: ${beside}.`;
    return {
      label: `${index + 1}. ${name} ${moscowClock(slot.windowStartAt)}–${moscowClock(slot.windowEndAt)}`,
      windowStartAt: slot.windowStartAt,
      windowEndAt: slot.windowEndAt,
      facts,
    };
  });
  const nameCounts = new Map<string, number>();
  for (const item of eligible) {
    nameCounts.set(item.displayName, (nameCounts.get(item.displayName) ?? 0) + 1);
  }
  const engineers = eligible.map((item) => {
    const route = load.get(item.engineerId);
    const facts = `вне линии, навык ${item.skills.map((skill) => skillLabel(skill)).join(', ')}, регион ${regionLabel(item.region)}, заявок ${route?.assignedCount ?? 0}`;
    const label =
      (nameCounts.get(item.displayName) ?? 0) > 1
        ? `${item.displayName} (${item.engineerId.slice(0, 4)})`
        : item.displayName;
    return { id: item.engineerId, label, facts };
  });
  const ownId = alert.engineerIds[0];
  const ownDay =
    ownId && alert.workDate
      ? await prisma.engineerDay.findUnique({
          where: { engineerId_workDate: { engineerId: ownId, workDate: alert.workDate } },
          include: { engineer: { select: { displayName: true } } },
        })
      : null;
  const ownRoute = ownId ? load.get(ownId) : undefined;
  const span = ownDay ? Number(ownDay.shiftEndAt) - Number(ownDay.shiftStartAt) : 0;
  const occupancy =
    span > 0 ? `${Math.round((100 * (ownRoute?.workTimeSec ?? 0)) / span)}%` : 'смена не задана';
  const engineerLine = ownDay
    ? `инженер ${ownDay.engineer.displayName}, ${ownDay.availability === 'online' ? 'на линии' : 'вне линии'}, занятость смены ${occupancy}, заявок ${ownRoute?.assignedCount ?? 0}`
    : 'инженер в алерте не указан';
  const requestLine = request
    ? `окно клиента ${moscowClock(Number(request.windowStartAt))}–${moscowClock(Number(request.windowEndAt))}, навык ${skillLabel(request.requiredSkill)}, регион ${regionLabel(request.region)}, адрес ${request.addressText}`
    : 'заявка в алерте не указана';
  const tomorrowLine =
    request && catalogue.includes('reschedule') ? await tomorrowLoadLine(prisma, request) : '';
  const reasons = Array.isArray(alert.reasons)
    ? alert.reasons.filter((item): item is string => typeof item === 'string').slice(0, 6)
    : [];
  const summary = decisionState({
    code: alert.code,
    reasons,
    facts: `${requestLine}. ${engineerLine}. ${tomorrowLine}Опоздание и соседние заявки — в причинах и в строках окон.`,
    windows: windows.map((item) => `${item.label}: ${item.facts}`),
    engineers: engineers.map((item) => `${item.label}: ${item.facts}`),
    actions,
  }).slice(0, 5_500);
  return {
    summary,
    actions,
    engineers,
    windows,
    requestVersion,
    minutes: alert.code === 'shift_no_show' ? [15] : [15, 30, 60],
  };
}

/**
 * Other open requests already placed on tomorrow inside this visit's clock window.
 * A failed read stays in the brief as unknown, so System one does not treat silence as zero.
 */
export async function tomorrowLoadLine(
  prisma: Pick<PrismaService, 'request' | '$transaction'>,
  request: {
    id: string;
    windowStartAt: bigint;
    windowEndAt: bigint;
  },
): Promise<string> {
  const start = Number(request.windowStartAt) + 86_400;
  const end = Number(request.windowEndAt) + 86_400;
  const dayStart = Math.floor((start + 3 * 60 * 60) / 86_400) * 86_400 - 3 * 60 * 60;
  try {
    const where: Prisma.RequestWhereInput = {
      id: { not: request.id },
      lifecycle: { in: ['submitted', 'in_progress'] },
      windowStartAt: { gte: BigInt(dayStart), lt: BigInt(Math.min(end, dayStart + 86_400)) },
      windowEndAt: { gt: BigInt(start) },
    };
    // Count and examples share one snapshot; only the display list is bounded.
    const [overlapCount, rows] = await prisma.$transaction(
      [
        prisma.request.count({ where }),
        prisma.request.findMany({
          where,
          select: { id: true, windowStartAt: true, windowEndAt: true },
          orderBy: [{ windowStartAt: 'asc' }, { id: 'asc' }],
          take: 6,
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return `${tomorrowCrewLine({
      overlapCount,
      windowStartAt: Number(request.windowStartAt),
      windowEndAt: Number(request.windowEndAt),
      others: rows.map((row) => ({
        id: row.id,
        windowStartAt: Number(row.windowStartAt),
        windowEndAt: Number(row.windowEndAt),
      })),
    })} `;
  } catch {
    return 'На завтра число заявок в это окно посчитать не удалось. ';
  }
}
