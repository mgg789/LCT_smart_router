import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { DispatchLiveView, LiveEngineerStateView } from '../../api/live-view.types';
import type { PlanRouteView, PlanStopView } from '../../api/plan-view';
import { toRequestView } from '../../api/request-view';
import type { LiveEngineerState, LiveWorkday } from '../../generated/prisma/client';
import { type Tx } from '../../persistence';
import { visibleRouterPhase } from '../../routing/router-gateway/router-phase';

/** Read-only LIVE projections that operate inside the caller's transaction. */
@Injectable()
export class LiveReadProjection {
  /** Returns break events from the applied operation journal for one workday. */
  async breakHistory(tx: Tx, day: LiveWorkday): Promise<DispatchLiveView['breaks']> {
    if (day.startedAtWallSec === null) return [];
    const rows = await tx.operation.findMany({
      where: {
        state: 'applied',
        action: { in: ['live.engineer.break_start', 'live.engineer.break_finish'] },
        createdAt: { gte: day.startedAtWallSec },
      },
      orderBy: { createdAt: 'asc' },
      select: { operationId: true, action: true, response: true },
    });
    const schema = z.object({
      value: z.object({
        workday: z.object({ id: z.string(), liveNow: z.number() }),
        engineer: z.object({
          id: z.string(),
          technicalBreak: z.object({ startedAt: z.number(), plannedEndAt: z.number() }).nullable(),
        }),
      }),
    });
    const events = rows.flatMap((row) => {
      const parsed = schema.safeParse(row.response);
      return parsed.success && parsed.data.value.workday.id === day.id
        ? [{ ...row, value: parsed.data.value }]
        : [];
    });
    return events.flatMap((event) => {
      const stop = event.value.engineer.technicalBreak;
      if (event.action !== 'live.engineer.break_start' || !stop) return [];
      const finish = events
        .filter(
          (other) =>
            other.action === 'live.engineer.break_finish' &&
            other.value.engineer.id === event.value.engineer.id &&
            other.value.workday.liveNow >= stop.startedAt,
        )
        .sort((a, b) => a.value.workday.liveNow - b.value.workday.liveNow)[0];
      return [
        {
          id: event.operationId,
          engineerId: event.value.engineer.id,
          ...stop,
          endedAt: finish?.value.workday.liveNow ?? null,
        },
      ];
    });
  }

  /** Exposes plan revision and geometry progress without loading route geometry. */
  async planFreshness(tx: Tx): Promise<{
    planRevision: number | null;
    calculating: boolean;
    routerPhase: 'building' | 'ready' | 'error';
    routerMessage: string | null;
    geometryDone: number;
    geometryTotal: number;
  }> {
    const [applied, published] = await Promise.all([
      tx.appliedPlanCurrent.findUnique({
        where: { id: 'singleton' },
        select: {
          plan: {
            select: {
              revision: true,
              validatedInputHash: true,
              routerResult: { select: { inputHash: true } },
            },
          },
        },
      }),
      tx.routingCurrent.findUnique({
        where: { id: 'singleton' },
        select: { snapshot: { select: { inputHash: true } } },
      }),
    ]);
    const appliedHash =
      applied?.plan.validatedInputHash ?? applied?.plan.routerResult?.inputHash ?? null;
    const publishedHash = published?.snapshot.inputHash ?? null;
    const phase = visibleRouterPhase(publishedHash !== null && publishedHash !== appliedHash);
    return {
      planRevision: applied?.plan.revision ?? null,
      calculating: phase.phase === 'building',
      routerPhase: phase.phase,
      routerMessage: phase.message,
      geometryDone: phase.geometryDone,
      geometryTotal: phase.geometryTotal,
    };
  }

  /** Aggregates durable request and LIVE outcome counters for a workday or engineer. */
  async statsFor(
    tx: Tx,
    day: LiveWorkday,
    engineerId?: string,
  ): Promise<DispatchLiveView['workday']['stats']> {
    const states = await tx.liveRequestState.findMany({
      where: { workdayId: day.id, ...(engineerId ? { reservedEngineerId: engineerId } : {}) },
      select: { requestId: true, assumedCompletedAt: true, problemKind: true },
    });
    const requestIds = states.map((state) => state.requestId);
    const [completedCount, cancelledCount, technicalBreakCount] = await Promise.all([
      requestIds.length === 0
        ? 0
        : tx.request.count({ where: { id: { in: requestIds }, lifecycle: 'completed' } }),
      requestIds.length === 0
        ? 0
        : tx.request.count({ where: { id: { in: requestIds }, lifecycle: 'cancelled' } }),
      tx.operation.count({
        where: {
          state: 'applied',
          action: 'live.engineer.break_start',
          ...(engineerId ? { targetRef: engineerId } : {}),
          createdAt: { gte: day.startedAtWallSec ?? BigInt(0) },
        },
      }),
    ]);
    return {
      completedCount,
      cancelledCount,
      assumedCompletedCount: states.filter((state) => state.assumedCompletedAt !== null).length,
      problemCount: states.filter((state) => state.problemKind !== null).length,
      technicalBreakCount,
    };
  }

  /** Projects completed, cancelled and silently completed visits as immutable history. */
  async historyView(
    tx: Tx,
    day: LiveWorkday & {
      requests: Array<import('../../generated/prisma/client').LiveRequestState>;
    },
  ): Promise<DispatchLiveView['history']> {
    const rows = await tx.request.findMany({
      where: {
        OR: [
          { lifecycle: 'completed' },
          { lifecycle: 'cancelled' },
          { liveStates: { some: { workdayId: day.id, assumedCompletedAt: { not: null } } } },
        ],
      },
      orderBy: { arrivalOrder: 'asc' },
    });
    const live = new Map(day.requests.map((item) => [item.requestId, item]));
    return Promise.all(
      rows.map(async (request) => {
        const assignment = await tx.appliedPlanAssignment.findFirst({
          where: { requestId: request.id },
          orderBy: { plan: { revision: 'desc' } },
        });
        const stopRow = assignment
          ? await tx.appliedPlanStop.findFirst({
              where: { requestId: request.id, route: { planId: assignment.planId } },
            })
          : null;
        const stop = stopRow
          ? {
              sequence: stopRow.sequence,
              kind: stopRow.kind,
              requestId: stopRow.requestId,
              lat: stopRow.lat,
              lon: stopRow.lon,
              arrivalAt: Number(stopRow.arrivalAt),
              startAt: Number(stopRow.startAt),
              endAt: Number(stopRow.endAt),
            }
          : null;
        const state = live.get(request.id) ?? null;
        return {
          request: toRequestView(request, state),
          engineerId: assignment?.engineerId ?? null,
          stop,
          outcome:
            state?.assumedCompletedAt !== null && state !== null
              ? ('assumed_completed' as const)
              : request.lifecycle === 'cancelled'
                ? ('cancelled' as const)
                : ('completed' as const),
          terminalAt: Number(
            state?.assumedCompletedAt ??
              request.cancelledAt ??
              request.completedAt ??
              request.updatedAt ??
              day.logicalStartAt,
          ),
        };
      }),
    );
  }
  /** Projects factual route progress inside the caller transaction, without mutating the plan. */
  async routeProgress(
    tx: Tx,
    state: LiveEngineerState,
    route: PlanRouteView | null,
    activeRequestId: string | null,
    lunch: { startedAt: number; endAt: number } | null,
    liveNow: number,
    suppressNext: boolean,
  ): Promise<LiveEngineerStateView['progress']> {
    const pointFor = async (requestId: string | null) => {
      if (requestId) {
        const request = await tx.request.findUnique({
          where: { id: requestId },
          select: { lat: true, lon: true },
        });
        if (request !== null && request.lat !== null && request.lon !== null) {
          return { kind: 'job' as const, requestId, lat: request.lat, lon: request.lon };
        }
      }
      return null;
    };
    const originBase =
      state.routeOriginLat !== null && state.routeOriginLon !== null
        ? {
            kind: 'start' as const,
            requestId: null,
            lat: state.routeOriginLat,
            lon: state.routeOriginLon,
          }
        : route?.startLat !== undefined && route.startLon !== undefined
          ? {
              kind: 'start' as const,
              requestId: null,
              lat: route.startLat,
              lon: route.startLon,
            }
          : null;
    if (!originBase) return null;
    const origin = {
      ...originBase,
      at: nullableNumber(state.routeOriginAt) ?? route?.startAt ?? liveNow,
    };
    const anchorBase = (await pointFor(state.routeAnchorRequestId)) ?? originBase;
    const anchor = {
      ...anchorBase,
      at: nullableNumber(state.routeAnchorReachedAt) ?? origin.at,
    };
    const routeJobs = (suppressNext ? [] : (route?.stops ?? [])).filter(
      (stop): stop is PlanStopView & { requestId: string } =>
        stop.kind === 'job' && stop.requestId !== null,
    );
    const anchorSequence = routeJobs.find(
      (stop) => stop.requestId === state.routeAnchorRequestId,
    )?.sequence;
    const possibleNext = routeJobs.filter(
      (stop) => anchorSequence === undefined || stop.sequence > anchorSequence,
    );
    const possibleIds = possibleNext.map((stop) => stop.requestId);
    const viableNext = await tx.request.findMany({
      where: {
        id: { in: possibleIds },
        lifecycle: 'submitted',
        liveStates: {
          none: { workdayId: state.workdayId, assumedCompletedAt: { not: null } },
        },
      },
      select: { id: true },
    });
    const viableIds = new Set(viableNext.map((request) => request.id));
    // The graph cursor moves forward from its durable anchor. Looking for merely a
    // different id can select an already traversed stop that appears earlier in the
    // immutable accepted plan.
    const nextStop = possibleNext.find((stop) => viableIds.has(stop.requestId));
    const next = nextStop?.requestId
      ? {
          kind: 'job' as const,
          requestId: nextStop.requestId,
          lat: nextStop.lat,
          lon: nextStop.lon,
          at: nextStop.startAt,
        }
      : null;
    const workday = await tx.liveWorkday.findUnique({
      where: { id: state.workdayId },
      select: { workDate: true },
    });
    const engineerDay = workday
      ? await tx.engineerDay.findUnique({
          where: {
            engineerId_workDate: { engineerId: state.engineerId, workDate: workday.workDate },
          },
          select: { lunchTaken: true },
        })
      : null;
    // Lunch is a structural part of the traversed edge as soon as the preceding job is
    // left. It is not a waiting vertex: the UI must highlight job→lunch→next before the
    // clock enters the break, and keep that compound edge until the next job is reached.
    const structuralLunch =
      engineerDay?.lunchTaken ||
      state.routeAnchorDepartedAt === null ||
      activeRequestId !== null ||
      nextStop === undefined
        ? null
        : (route?.stops.find(
            (stop) =>
              stop.kind === 'lunch' &&
              stop.sequence < nextStop.sequence &&
              (anchorSequence === undefined || stop.sequence > anchorSequence),
          ) ?? null);
    const persistedLunch =
      state.activeLunchLat !== null &&
      state.activeLunchLon !== null &&
      state.activeLunchStartedAt !== null
        ? {
            kind: 'lunch' as const,
            requestId: null,
            lat: state.activeLunchLat,
            lon: state.activeLunchLon,
            at: Number(state.activeLunchStartedAt),
          }
        : null;
    if (lunch || persistedLunch || structuralLunch) {
      const lunchStop = route?.stops.find(
        (stop) =>
          stop.kind === 'lunch' &&
          (lunch
            ? stop.startAt <= lunch.startedAt && lunch.startedAt < stop.endAt
            : persistedLunch !== null
              ? stop.lat === persistedLunch.lat && stop.lon === persistedLunch.lon
              : stop === structuralLunch),
      );
      const lunchPoint =
        persistedLunch ??
        (lunch
          ? lunchStop
            ? {
                kind: 'lunch' as const,
                requestId: null,
                lat: lunchStop.lat,
                lon: lunchStop.lon,
                at: lunch.startedAt,
              }
            : null
          : structuralLunch
            ? {
                kind: 'lunch' as const,
                requestId: null,
                lat: structuralLunch.lat,
                lon: structuralLunch.lon,
                at: structuralLunch.startAt,
              }
            : null);
      const afterLunch = possibleNext.find(
        (stop) => viableIds.has(stop.requestId) && (!lunch || stop.startAt >= lunch.endAt),
      );
      return {
        phase: lunch ? 'lunch' : 'traveling',
        origin,
        anchor,
        lunch: lunchPoint,
        next: afterLunch?.requestId
          ? {
              kind: 'job',
              requestId: afterLunch.requestId,
              lat: afterLunch.lat,
              lon: afterLunch.lon,
              at: afterLunch.startAt,
            }
          : next,
        occurredAt: liveNow,
      };
    }
    if (activeRequestId) {
      const active = await pointFor(activeRequestId);
      if (active) {
        const reachedAt = nullableNumber(state.routeAnchorReachedAt) ?? liveNow;
        return {
          phase: 'on_site',
          origin,
          anchor: { ...active, at: reachedAt },
          lunch: null,
          next,
          occurredAt: reachedAt,
        };
      }
    }
    if (state.routeAnchorDepartedAt !== null) {
      return {
        phase: 'traveling',
        origin,
        anchor,
        lunch: null,
        next,
        occurredAt: liveNow,
      };
    }
    return {
      // Going online is a factual departure from the depot. The start marker remains
      // only as the origin of the highlighted first edge until the first explicit or
      // silent job start reaches its vertex.
      phase: state.lineStartedAt === null ? 'not_started' : 'traveling',
      origin,
      anchor,
      lunch: null,
      next,
      occurredAt:
        state.lineStartedAt === null
          ? (nullableNumber(state.routeAnchorReachedAt) ?? liveNow)
          : liveNow,
    };
  }
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
