import { Injectable } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import type { EngineerRewardCategory } from '../../generated/prisma/client';
import { Prisma } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { PrismaService, type Tx } from '../../persistence';
import { moscowMonth, moscowMonthBounds } from '../passports/passport-policy';
import { arrivalReward, completionReward, type RewardPolicyDecision } from './reward-policy';

export interface RewardEntryView {
  readonly id: string;
  readonly requestId: string | null;
  readonly workdayId: string | null;
  readonly category: EngineerRewardCategory;
  readonly points: number;
  readonly awardedAt: number;
  readonly reason: string;
  readonly evidence: Prisma.JsonValue;
}

export interface RewardSummary {
  readonly month: string;
  readonly monthlyPoints: number;
  readonly earnedPoints: number;
  readonly penaltyPoints: number;
  readonly teamAverage: number | null;
  readonly teamRatio: number | null;
  readonly categories: Readonly<Record<EngineerRewardCategory, number>>;
  readonly recentEntries: readonly RewardEntryView[];
}

export interface RewardDaySummary {
  readonly workdayId: string;
  readonly workDate: string;
  readonly monthlyPoints: number;
  readonly earnedPoints: number;
  readonly penaltyPoints: number;
  readonly categories: Readonly<Record<EngineerRewardCategory, number>>;
  readonly entries: readonly RewardEntryView[];
}

type RewardRow = {
  readonly id: string;
  readonly requestId: string | null;
  readonly workdayId: string | null;
  readonly category: EngineerRewardCategory;
  readonly points: number;
  readonly awardedAt: bigint;
  readonly reason: string;
  readonly evidence: Prisma.JsonValue;
};

const CATEGORIES: readonly EngineerRewardCategory[] = [
  'arrival',
  'completion',
  'passport',
  'penalty',
];

/** Durable rewards ledger and pure-policy integration point for LIVE and reports. */
@Injectable()
export class RewardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Records one positive reward if the policy accepts the explicit action. */
  async evaluateArrival(
    context: OperationContext,
    input: {
      readonly engineerId: string;
      readonly requestId: string;
      readonly workdayId: string;
      readonly actualAt: number;
      readonly plannedAt: number;
      readonly windowStartAt: number;
      readonly promiseAt?: number | null;
      readonly promiseRecordedAt?: number | null;
      readonly baselineAt?: number | null;
      readonly ownerMatches?: boolean;
      /** LIVE logical action time; wall time remains the ledger bucket timestamp. */
      readonly logicalActionAt?: number;
    },
  ): Promise<RewardEntryView | null> {
    const decision = arrivalReward({
      ...input,
      actionRecordedAt: input.logicalActionAt ?? context.now,
    });
    if (!decision) return null;
    return this.awardPositive(context.tx, {
      ...input,
      category: 'arrival',
      decision,
      awardedAt: context.now,
      logicalAt: input.actualAt,
      operationId: `${context.operationId}:arrival`,
      reason:
        decision.kind === 'ordinary'
          ? 'Explicit arrival/start within the frozen planned start'
          : 'Explicit arrival within ten minutes before the accepted ETA',
    });
  }

  /** Records one positive completion reward if the explicit finish meets the policy. */
  async evaluateCompletion(
    context: OperationContext,
    input: {
      readonly engineerId: string;
      readonly requestId: string;
      readonly workdayId: string;
      readonly actualAt: number;
      readonly originalFinishAt: number;
      readonly promiseAt?: number | null;
      readonly promiseRecordedAt?: number | null;
      readonly baselineAt?: number | null;
      readonly ownerMatches?: boolean;
      readonly allowAfterBaseline?: boolean;
      /** LIVE logical action time; wall time remains the ledger bucket timestamp. */
      readonly logicalActionAt?: number;
    },
  ): Promise<RewardEntryView | null> {
    const decision = completionReward({
      ...input,
      plannedAt: input.originalFinishAt,
      actionRecordedAt: input.logicalActionAt ?? context.now,
      allowAfterBaseline: input.allowAfterBaseline,
    });
    if (!decision) return null;
    return this.awardPositive(context.tx, {
      ...input,
      category: 'completion',
      decision,
      awardedAt: context.now,
      logicalAt: input.actualAt,
      operationId: `${context.operationId}:completion`,
      reason:
        decision.kind === 'ordinary'
          ? 'Explicit completion within the original norm'
          : 'Explicit completion within ten minutes before the accepted promised finish',
    });
  }

  /** Adds the bounded object-passport reward to the same ledger. */
  async awardPassport(
    tx: Tx,
    input: {
      readonly engineerId: string;
      readonly operationId: string;
      readonly requestId?: string;
      readonly workdayId?: string | null;
      readonly awardedAt: number;
      readonly logicalAt?: number;
    },
  ): Promise<RewardEntryView> {
    return this.award(tx, {
      engineerId: input.engineerId,
      // Passport refreshes on one request are legitimate separate facts. Keep the
      // request id in evidence while leaving requestId nullable so the request/category
      // idempotency key applies to arrival and completion facts only.
      requestId: null,
      workdayId: input.workdayId ?? null,
      category: 'passport',
      points: 35,
      operationId: input.operationId,
      awardedAt: input.awardedAt,
      reason: 'Object passport recorded for a started visit',
      evidence: {
        policy: 'ordinary',
        requestId: input.requestId ?? null,
        logicalAt: input.logicalAt ?? input.awardedAt,
        awardedAt: input.awardedAt,
      },
      dedupKey: `passport:${input.operationId}`,
    });
  }

  /** Records an explicit dispatcher penalty and verifies its request/fact linkage. */
  async recordPenalty(
    context: OperationContext,
    input: {
      readonly engineerId: string;
      readonly requestId: string;
      readonly factId: string;
      readonly reason: string;
    },
  ): Promise<RewardEntryView> {
    if (input.reason.trim().length < 30)
      throw SysError.validationFailed('Penalty reason must contain at least 30 characters');
    const fact = await context.tx.requestFact.findUnique({
      where: { id: input.factId },
      select: { id: true, requestId: true, engineerId: true, kind: true, occurredAt: true },
    });
    if (!fact || fact.requestId !== input.requestId || fact.engineerId !== input.engineerId) {
      throw SysError.validationFailed(
        'Penalty fact must belong to the selected request and engineer',
      );
    }
    const liveStates = await context.tx.liveRequestState.findMany({
      where: { requestId: input.requestId },
      select: {
        workdayId: true,
        workday: { select: { logicalStartAt: true, logicalEndAt: true } },
      },
    });
    const occurredAt = Number(fact.occurredAt);
    const factWorkday =
      liveStates.find(
        (state) =>
          occurredAt >= Number(state.workday.logicalStartAt) &&
          occurredAt <= Number(state.workday.logicalEndAt),
      ) ?? (liveStates.length === 1 ? liveStates[0] : null);
    const engineer = await context.tx.engineer.findUnique({
      where: { id: input.engineerId },
      select: { id: true },
    });
    if (!engineer) throw SysError.notFound('Engineer', { engineerId: input.engineerId });
    return this.award(context.tx, {
      engineerId: input.engineerId,
      requestId: input.requestId,
      workdayId: factWorkday?.workdayId ?? null,
      category: 'penalty',
      points: -50,
      operationId: context.operationId,
      awardedAt: context.now,
      reason: input.reason.trim(),
      evidence: {
        kind: 'manual_penalty',
        factId: fact.id,
        factKind: fact.kind,
        factOccurredAt: Number(fact.occurredAt),
        workdayId: factWorkday?.workdayId ?? null,
        dispatcherOperationId: context.operationId,
      },
      dedupKey: `${input.requestId}:penalty:${input.factId}`,
    });
  }

  /** Legacy points API backed by the unified ledger. */
  async monthlyPoints(engineerId: string, now = this.clock.nowSeconds()) {
    const summary = await this.summary(engineerId, now);
    return { monthlyPoints: summary.monthlyPoints, month: summary.month };
  }

  /** Transaction-aware total used when a passport reward is still uncommitted. */
  async monthlyPointsIn(
    client: Pick<PrismaService, 'engineerReward'> | Pick<Tx, 'engineerReward'>,
    engineerId: string,
    now = this.clock.nowSeconds(),
  ): Promise<number> {
    const [start, end] = moscowMonthBounds(now);
    const total = await client.engineerReward.aggregate({
      where: { engineerId, awardedAt: { gte: BigInt(start), lt: BigInt(end) } },
      _sum: { points: true },
    });
    return total._sum.points ?? 0;
  }

  /** Returns the Moscow-calendar monthly totals and team benchmark. */
  async summary(engineerId: string, now = this.clock.nowSeconds()): Promise<RewardSummary> {
    const [start, end] = moscowMonthBounds(now);
    const entries = await this.prisma.engineerReward.findMany({
      where: { engineerId, awardedAt: { gte: BigInt(start), lt: BigInt(end) } },
      orderBy: { awardedAt: 'desc' },
    });
    const legacy = await this.unmigratedPassportRows(engineerId, start, end);
    const allEntries = [...entries, ...legacy].sort((a, b) => Number(b.awardedAt - a.awardedAt));
    const totals = await this.monthTotals(start, end);
    return this.toSummary(moscowMonth(now), allEntries, totals);
  }

  /** Returns all rewards attached to one durable LIVE workday. */
  async daySummary(engineerId: string, workdayId: string): Promise<RewardDaySummary> {
    const workday = await this.prisma.liveWorkday.findUnique({
      where: { id: workdayId },
      select: { id: true, workDate: true },
    });
    if (!workday) throw SysError.notFound('Workday', { workdayId });
    const entries = await this.prisma.engineerReward.findMany({
      where: { engineerId, workdayId },
      orderBy: { awardedAt: 'desc' },
    });
    return {
      workdayId: workday.id,
      workDate: workday.workDate,
      ...this.aggregate(entries),
      entries: entries.map((entry) => this.toEntry(entry)),
    };
  }

  private async monthTotals(start: number, end: number) {
    const rows = await this.prisma.engineerReward.findMany({
      where: { awardedAt: { gte: BigInt(start), lt: BigInt(end) } },
      select: { engineerId: true, points: true },
    });
    const byEngineer = new Map<string, number>();
    for (const row of rows)
      byEngineer.set(row.engineerId, (byEngineer.get(row.engineerId) ?? 0) + row.points);
    const legacy = await this.prisma.engineerPassportPoint.findMany({
      where: { awardedAt: { gte: BigInt(start), lt: BigInt(end) } },
      select: { engineerId: true, operationId: true, points: true },
    });
    const migrated = new Set(
      (await this.prisma.engineerReward.findMany({ select: { operationId: true } })).flatMap(
        (row) => [row.operationId, row.operationId.replace(/^legacy-passport:/, '')],
      ),
    );
    for (const row of legacy) {
      if (!migrated.has(row.operationId))
        byEngineer.set(row.engineerId, (byEngineer.get(row.engineerId) ?? 0) + row.points);
    }
    const active = await this.prisma.engineer.findMany({
      where: { archivedAt: null },
      select: { id: true },
    });
    const roster = new Set([...active.map((row) => row.id), ...byEngineer.keys()]);
    const average =
      roster.size === 0
        ? null
        : [...roster].reduce((sum, id) => sum + (byEngineer.get(id) ?? 0), 0) / roster.size;
    return { byEngineer, average };
  }

  private toSummary(
    month: string,
    entries: readonly RewardRow[],
    totals: { byEngineer: Map<string, number>; average: number | null },
  ): RewardSummary {
    const aggregate = this.aggregate(entries);
    const points = aggregate.monthlyPoints;
    return {
      month,
      ...aggregate,
      teamAverage: totals.average,
      teamRatio: totals.average !== null && totals.average > 0 ? points / totals.average : null,
      recentEntries: aggregate.entries.slice(0, 50),
    };
  }

  private aggregate(entries: readonly RewardRow[]) {
    const categories = Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<
      EngineerRewardCategory,
      number
    >;
    let monthlyPoints = 0;
    for (const entry of entries) {
      monthlyPoints += entry.points;
      categories[entry.category] += entry.points;
    }
    return {
      monthlyPoints,
      earnedPoints: monthlyPoints - categories.penalty,
      penaltyPoints: categories.penalty,
      categories,
      entries: entries.map((entry) => this.toEntry(entry)),
    };
  }

  private async awardPositive(
    tx: Tx,
    input: {
      readonly engineerId: string;
      readonly requestId: string | null;
      readonly workdayId: string | null;
      readonly category: EngineerRewardCategory;
      readonly decision: RewardPolicyDecision;
      readonly operationId: string;
      readonly awardedAt: number;
      readonly logicalAt: number;
      readonly reason: string;
    },
  ) {
    return this.award(tx, {
      ...input,
      points: input.decision.points,
      evidence: {
        policy: input.decision.kind,
        logicalAt: input.logicalAt,
        awardedAt: input.awardedAt,
        corridorSec: input.decision.corridorSec ?? null,
      },
      dedupKey: `${input.requestId}:${input.category}`,
    });
  }

  private async award(
    tx: Tx,
    input: {
      readonly engineerId: string;
      readonly requestId: string | null;
      readonly workdayId: string | null;
      readonly category: EngineerRewardCategory;
      readonly points: number;
      readonly operationId: string;
      readonly awardedAt: number;
      readonly reason: string;
      readonly evidence: Prisma.InputJsonValue;
      readonly dedupKey: string;
    },
  ): Promise<RewardEntryView> {
    const row = await tx.engineerReward.upsert({
      where: { dedupKey: input.dedupKey },
      // A scalar no-op keeps this a database-native upsert. An empty update lets
      // Prisma emulate read/create, which races across distinct operation IDs.
      update: { dedupKey: input.dedupKey },
      create: {
        engineerId: input.engineerId,
        requestId: input.requestId,
        workdayId: input.workdayId,
        category: input.category,
        points: input.points,
        operationId: input.operationId,
        dedupKey: input.dedupKey,
        awardedAt: BigInt(input.awardedAt),
        reason: input.reason,
        evidence: input.evidence,
      },
    });
    return this.toEntry(row);
  }

  private toEntry(entry: {
    id: string;
    requestId: string | null;
    workdayId: string | null;
    category: EngineerRewardCategory;
    points: number;
    awardedAt: bigint;
    reason: string;
    evidence: Prisma.JsonValue;
  }): RewardEntryView {
    return {
      id: entry.id,
      requestId: entry.requestId,
      workdayId: entry.workdayId,
      category: entry.category,
      points: entry.points,
      awardedAt: Number(entry.awardedAt),
      reason: entry.reason,
      evidence: entry.evidence,
    };
  }

  private async unmigratedPassportRows(
    engineerId: string,
    start: number,
    end: number,
  ): Promise<RewardRow[]> {
    const oldRows = await this.prisma.engineerPassportPoint.findMany({
      where: { engineerId, awardedAt: { gte: BigInt(start), lt: BigInt(end) } },
    });
    const operationIds = new Set(
      (await this.prisma.engineerReward.findMany({ select: { operationId: true } })).flatMap(
        (row) => [row.operationId, row.operationId.replace(/^legacy-passport:/, '')],
      ),
    );
    return oldRows
      .filter((row) => !operationIds.has(row.operationId))
      .map((row) => ({
        id: `legacy-unmigrated:${row.id}`,
        requestId: null,
        workdayId: null,
        category: 'passport' as const,
        points: row.points,
        awardedAt: row.awardedAt,
        reason: 'Legacy object passport reward retained for compatibility',
        evidence: {
          legacy: true,
          source: 'engineer_passport_points',
          operationId: row.operationId,
        },
      }));
  }
}
