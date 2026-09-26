import { Injectable } from '@nestjs/common';
import { type PlanRouteView, type PlanStopView, toPlanView } from '../../api/plan-view';
import { toRequestView } from '../../api/request-view';
import type { LiveRequestState, LiveWorkday } from '../../generated/prisma/client';
import type { Tx } from '../../persistence';
import { AppliedPlanService } from '../../routing/router-gateway';
import type { DayWithStates } from './live-day-state';

/** Read-only route overlays for current engineer actions. */
@Injectable()
export class LiveRouteQuery {
  constructor(private readonly plans: AppliedPlanService) {}

  /** Projects the factual graph cursor without allowing a fresh Router revision to move it. */
  async currentFor(
    tx: Tx,
    day: DayWithStates | LiveWorkday,
    engineerId: string,
    liveNow: number,
    loadedRoutes?: readonly PlanRouteView[],
    loadedRevision?: number | null,
  ) {
    let routes: readonly PlanRouteView[];
    let revision: number | null;
    if (loadedRoutes) {
      routes = loadedRoutes;
      revision = loadedRevision ?? null;
    } else {
      const plan = await this.plans.current(tx);
      routes = plan ? toPlanView(plan).routes : [];
      revision = plan?.revision ?? null;
    }
    let route = routes.find((item) => item.engineerId === engineerId) ?? null;
    const stateRows: LiveRequestState[] =
      'requests' in day
        ? day.requests
        : await tx.liveRequestState.findMany({ where: { workdayId: day.id } });
    const assumed = new Set(
      stateRows.filter((item) => item.assumedCompletedAt !== null).map((item) => item.requestId),
    );
    const liveByRequest = new Map(stateRows.map((item) => [item.requestId, item]));
    const active = await tx.request.findFirst({
      where: { lifecycle: 'in_progress', facts: { some: { engineerId, kind: 'started' } } },
      orderBy: { startedAt: 'desc' },
    });
    if (active) {
      const startedAt = Number(active.startedAt);
      const plannedStop: PlanStopView | null =
        route?.stops.find((item) => item.requestId === active.id) ??
        (active.lat !== null && active.lon !== null
          ? {
              sequence: 0,
              kind: 'job',
              requestId: active.id,
              lat: active.lat,
              lon: active.lon,
              arrivalAt: startedAt,
              startAt: startedAt,
              endAt: Number(
                active.expectedCompletionAt ?? BigInt(startedAt + active.serviceDurationSec),
              ),
            }
          : null);
      const stop = plannedStop
        ? {
            ...plannedStop,
            arrivalAt: startedAt,
            startAt: startedAt,
            endAt: Number(
              active.expectedCompletionAt ?? BigInt(startedAt + active.serviceDurationSec),
            ),
          }
        : null;
      if (stop && route?.stops.some((item) => item.requestId === active.id))
        route = {
          ...route,
          stops: route.stops.map((item) => (item.requestId === active.id ? stop : item)),
        };
      if (stop && !route?.stops.some((item) => item.requestId === active.id)) {
        route = route
          ? { ...route, stops: [stop, ...route.stops] }
          : {
              engineerId,
              startLat: stop.lat,
              startLon: stop.lon,
              startAt: stop.startAt,
              finishAt: stop.endAt,
              distanceKm: 0,
              travelTimeSec: 0,
              workTimeSec: active.serviceDurationSec,
              waitingTimeSec: 0,
              lunchTimeSec: 0,
              assignedCount: 1,
              lunchStatus: 'none',
              legs: [],
              stops: [stop],
            };
      }
      return {
        route,
        stop,
        phase: 'in_progress' as const,
        current: {
          request: toRequestView(active, liveByRequest.get(active.id) ?? null),
          stop,
          phase: 'in_progress' as const,
          expectedCompletionAt: nullableNumber(active.expectedCompletionAt),
          overrunAt: nullableNumber(active.overrunDetectedAt),
        },
      };
    }
    if (await this.activeLunch(tx, day.workDate, engineerId, route, liveNow))
      return { route, stop: null, phase: null, current: null };
    const replanPending = stateRows.some(
      (item) =>
        item.replanPendingEngineerId === engineerId &&
        item.replanPendingPlanRevision !== null &&
        item.replanPendingPlanRevision === revision,
    );
    if (replanPending)
      return { route, stop: null, phase: null, current: null, replanPending: true as const };
    const reserved = await tx.liveRequestState.findFirst({
      where: {
        workdayId: day.id,
        reservedEngineerId: engineerId,
        assumedCompletedAt: null,
        request: { lifecycle: 'submitted' },
        OR: [{ reportedEtaAt: { not: null } }, { assumedStartedAt: { not: null } }],
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (reserved) {
      const request = await tx.request.findUnique({ where: { id: reserved.requestId } });
      if (request?.lifecycle === 'submitted') {
        if (request.lat === null || request.lon === null)
          return { route, stop: null, phase: null, current: null };
        const reservedAt = reserved.reportedEtaAt ?? reserved.assumedStartedAt;
        if (reservedAt === null) throw new Error('A reserved visit requires a start forecast');
        const plannedAt = Number(reservedAt);
        const stop: PlanStopView = {
          sequence: 0,
          kind: 'job',
          requestId: request.id,
          lat: request.lat,
          lon: request.lon,
          arrivalAt: plannedAt,
          startAt: plannedAt,
          endAt: plannedAt + request.serviceDurationSec,
        };
        if (route) {
          const withoutPinned = route.stops.filter((item) => item.requestId !== request.id);
          route = {
            ...route,
            assignedCount: route.assignedCount + 1,
            workTimeSec: route.workTimeSec + request.serviceDurationSec,
            stops: [stop, ...withoutPinned]
              .sort((a, b) => a.startAt - b.startAt)
              .map((item, index) => ({ ...item, sequence: index })),
          };
        } else
          route = {
            engineerId,
            startLat: request.lat,
            startLon: request.lon,
            startAt: plannedAt,
            finishAt: stop.endAt,
            distanceKm: 0,
            travelTimeSec: 0,
            workTimeSec: request.serviceDurationSec,
            waitingTimeSec: 0,
            lunchTimeSec: 0,
            assignedCount: 1,
            lunchStatus: 'none',
            legs: [],
            stops: [stop],
          };
        const phase =
          liveNow < plannedAt && liveNow < request.windowStartAt
            ? ('awaiting_window' as const)
            : ('ready_to_start' as const);
        return {
          route,
          stop,
          phase,
          current: {
            request: toRequestView(request, reserved),
            stop,
            phase,
            expectedCompletionAt: null,
            overrunAt: null,
          },
        };
      }
    }
    const stops = (route?.stops ?? []).filter(
      (stop) =>
        stop.kind === 'job' &&
        stop.requestId &&
        !assumed.has(stop.requestId) &&
        stop.endAt >= liveNow,
    );
    const requestIds = stops.flatMap((stop) => (stop.requestId ? [stop.requestId] : []));
    const requests = await tx.request.findMany({
      where: { id: { in: requestIds }, lifecycle: 'submitted' },
    });
    const requestsById = new Map(requests.map((request) => [request.id, request]));
    const stop = stops.find((item) => item.requestId && requestsById.has(item.requestId)) ?? null;
    const request = stop?.requestId ? (requestsById.get(stop.requestId) ?? null) : null;
    if (!stop || !request) return { route, stop: null, phase: null, current: null };
    const phase =
      liveNow < stop.startAt && liveNow < Number(request.windowStartAt)
        ? ('awaiting_window' as const)
        : ('ready_to_start' as const);
    return {
      route,
      stop,
      phase,
      current: {
        request: toRequestView(request, liveByRequest.get(request.id) ?? null),
        stop,
        phase,
        expectedCompletionAt: null,
        overrunAt: null,
      },
    };
  }

  /** Keeps an entered automatic lunch blocking after a remaining-day plan omits it. */
  async activeLunch(
    tx: Tx,
    workDate: string,
    engineerId: string,
    _route: PlanRouteView | null,
    liveNow: number,
  ): Promise<{ startedAt: number; endAt: number } | null> {
    const day = await tx.engineerDay.findUnique({
      where: { engineerId_workDate: { engineerId, workDate } },
    });
    if (!day?.lunchTaken || day.lunchStartedAt === null || !day.lunchDurationSec) return null;
    const startedAt = Number(day.lunchStartedAt);
    const endAt = startedAt + day.lunchDurationSec;
    return startedAt <= liveNow && liveNow < endAt ? { startedAt, endAt } : null;
  }
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
