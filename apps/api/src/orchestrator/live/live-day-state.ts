import { Injectable } from '@nestjs/common';
import type { LiveWorkdayView } from '../../api/live-view.types';
import { toPlanView } from '../../api/plan-view';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import type {
  Engineer,
  LiveEngineerState,
  LiveRequestState,
  LiveWorkday,
} from '../../generated/prisma/client';
import { APP_STATE_KEYS, type Tx } from '../../persistence';
import { AppliedPlanService } from '../../routing/router-gateway';
import { workDateOf } from '../engineers/workday';
import { LiveReadProjection } from './live-read-projection';
import { NO_SHOW_SEC } from './replan-policy';

/** A workday together with the durable LIVE rows needed by read and command flows. */
export type DayWithStates = LiveWorkday & {
  engineers: Array<LiveEngineerState & { engineer: Engineer }>;
  requests: LiveRequestState[];
};

/**
 * Owns durable LIVE-day setup and clock conversion.
 *
 * All methods receive the caller transaction so day creation and roster initialization
 * remain atomic with the command or read that caused them.
 */
@Injectable()
export class LiveDayState {
  constructor(
    private readonly config: AppConfigService,
    private readonly plans: AppliedPlanService,
    private readonly readProjection: LiveReadProjection,
  ) {}

  /** Returns the running day or creates/refreshes the pending card for the current roster. */
  async ensureDay(tx: Tx, wallNow: number): Promise<LiveWorkday> {
    const generationRow = await tx.appState.findUnique({
      where: { key: APP_STATE_KEYS.GENERATION },
    });
    const generation = typeof generationRow?.value === 'number' ? generationRow.value : 1;
    const running = await tx.liveWorkday.findFirst({
      where: { generation, status: 'running' },
      orderBy: { startedAtWallSec: 'desc' },
    });
    if (running) return running;
    const workDate = workDateOf(wallNow, this.config.get('APP_TIME_ZONE'));
    const existing = await tx.liveWorkday.findUnique({
      where: { generation_workDate: { generation, workDate } },
    });
    const [days, requests] = await Promise.all([
      tx.engineerDay.findMany({
        where: { workDate },
        select: { shiftStartAt: true, shiftEndAt: true },
      }),
      tx.request.findMany({
        where: { lifecycle: 'submitted', windowEndAt: { gte: BigInt(wallNow - 24 * 3600) } },
        select: { windowStartAt: true, windowEndAt: true },
      }),
    ]);
    const starts = [
      ...days.flatMap((item) => (item.shiftStartAt === null ? [] : [Number(item.shiftStartAt)])),
      ...requests.map((item) => Number(item.windowStartAt)),
    ].filter(Number.isSafeInteger);
    const ends = [
      ...days.flatMap((item) => (item.shiftEndAt === null ? [] : [Number(item.shiftEndAt)])),
      ...requests.map((item) => Number(item.windowEndAt)),
    ].filter(Number.isSafeInteger);
    const logicalStartAt = starts.length > 0 ? Math.min(...starts) : wallNow;
    const logicalEndAt = Math.max(
      logicalStartAt + 1,
      Date.parse(`${workDate}T17:00:00+03:00`) / 1000,
      ...(ends.length > 0 ? ends : [logicalStartAt + 8 * 3600]),
    );
    if (existing) {
      if (
        existing.status === 'pending' &&
        (Number(existing.logicalStartAt) !== logicalStartAt ||
          Number(existing.logicalEndAt) !== logicalEndAt)
      ) {
        return tx.liveWorkday.update({
          where: { id: existing.id },
          data: {
            logicalStartAt: BigInt(logicalStartAt),
            logicalEndAt: BigInt(logicalEndAt),
            updatedAt: BigInt(wallNow),
            version: { increment: 1 },
          },
        });
      }
      return existing;
    }
    return tx.liveWorkday.upsert({
      where: { generation_workDate: { generation, workDate } },
      update: {},
      create: {
        generation,
        workDate,
        logicalStartAt: BigInt(logicalStartAt),
        logicalEndAt: BigInt(logicalEndAt),
        createdAt: BigInt(wallNow),
        updatedAt: BigInt(wallNow),
      },
    });
  }

  /** Initializes active-roster state in one idempotent batch for the polling path. */
  async ensureEngineerStates(tx: Tx, workdayId: string, wallNow: number): Promise<void> {
    const workday = await tx.liveWorkday.findUniqueOrThrow({ where: { id: workdayId } });
    const days = await tx.engineerDay.findMany({
      where: { workDate: workday.workDate, engineer: { archivedAt: null } },
      select: { engineerId: true },
    });
    if (days.length === 0) return;
    await tx.liveEngineerState.createMany({
      data: days.map((day) => ({
        workdayId,
        engineerId: day.engineerId,
        createdAt: BigInt(wallNow),
        updatedAt: BigInt(wallNow),
      })),
      skipDuplicates: true,
    });
  }

  /** Captures the first accepted route origin so subsequent replans cannot move history. */
  async captureRouteOrigins(
    tx: Tx,
    workdayId: string,
    logicalStartAt: number,
    wallNow: number,
  ): Promise<void> {
    const plan = await this.plans.current(tx);
    if (!plan) return;
    const routes = new Map(toPlanView(plan).routes.map((route) => [route.engineerId, route]));
    const states = await tx.liveEngineerState.findMany({
      where: {
        workdayId,
        OR: [{ routeOriginLat: null }, { routeOriginLon: null }, { routeOriginAt: null }],
      },
    });
    for (const state of states) {
      const route = routes.get(state.engineerId);
      if (!route || route.startLat === undefined || route.startLon === undefined) continue;
      await tx.liveEngineerState.update({
        where: { id: state.id },
        data: {
          routeOriginLat: route.startLat,
          routeOriginLon: route.startLon,
          routeOriginAt: BigInt(logicalStartAt),
          updatedAt: BigInt(wallNow),
          version: { increment: 1 },
        },
      });
    }
  }

  /** Ensures and returns one engineer's durable LIVE state. */
  async requireEngineerState(
    tx: Tx,
    workdayId: string,
    engineerId: string,
    wallNow: number,
  ): Promise<LiveEngineerState> {
    await this.ensureEngineerStates(tx, workdayId, wallNow);
    const state = await tx.liveEngineerState.findUnique({
      where: { workdayId_engineerId: { workdayId, engineerId } },
    });
    if (!state) throw SysError.notFound('Engineer', { engineerId });
    return state;
  }

  /** Loads the day with the stable roster order required by LIVE views. */
  async dayWithStates(tx: Tx, id: string): Promise<DayWithStates> {
    return tx.liveWorkday.findUniqueOrThrow({
      where: { id },
      include: {
        engineers: { include: { engineer: true }, orderBy: { engineer: { inputOrder: 'asc' } } },
        requests: true,
      },
    });
  }

  /** Converts wall seconds to the durable logical clock without freezing active actions at shift end. */
  liveNow(
    day: Pick<
      LiveWorkday,
      | 'status'
      | 'logicalStartAt'
      | 'logicalEndAt'
      | 'startedAtWallSec'
      | 'speedDurationSec'
      | 'finishedAt'
    >,
    wallNow: number,
  ): number {
    const start = Number(day.logicalStartAt);
    if (day.status === 'finished')
      return nullableNumber(day.finishedAt) ?? Number(day.logicalEndAt);
    if (day.status !== 'running' || day.startedAtWallSec === null) return start;
    const duration = Math.max(1, Number(day.logicalEndAt) - start);
    const elapsedWall = Math.max(0, wallNow - Number(day.startedAtWallSec));
    return (
      start +
      (day.speedDurationSec === null
        ? elapsedWall
        : Math.floor((elapsedWall * duration) / day.speedDurationSec))
    );
  }

  /** Builds the shared workday response without loading route geometry. */
  async toWorkdayView(
    tx: Tx,
    day: LiveWorkday,
    wallNow: number,
    requestCount: number,
  ): Promise<LiveWorkdayView> {
    const duration = Math.max(1, Number(day.logicalEndAt) - Number(day.logicalStartAt));
    return {
      id: day.id,
      status: day.status,
      workDate: day.workDate,
      logicalStartAt: Number(day.logicalStartAt),
      logicalEndAt: Number(day.logicalEndAt),
      startedAtWallSec: nullableNumber(day.startedAtWallSec),
      finishedAt: nullableNumber(day.finishedAt),
      completionReason:
        day.completionReason === 'schedule_exhausted' || day.completionReason === 'logical_end'
          ? day.completionReason
          : null,
      liveNow: this.liveNow(day, wallNow),
      speedDurationSec: day.speedDurationSec,
      speedFactor: day.speedDurationSec === null ? 1 : duration / day.speedDurationSec,
      engineerStartDeadlineAt: Number(day.logicalStartAt) + NO_SHOW_SEC,
      requestCount,
      stats: await this.readProjection.statsFor(tx, day),
      ...(await this.readProjection.planFreshness(tx)),
    };
  }
}

function nullableNumber(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}
