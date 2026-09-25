import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import type { NotificationCategory, Prisma } from '../generated/prisma/client';
import { moscowMonth, moscowMonthBounds } from '../orchestrator/passports/passport-policy';
import { PrismaService, type Tx, UnitOfWork } from '../persistence';
import { type MonthlyReportData, monthlyReportSchema } from './monthly-report.types';
import { NotificationsService } from './notifications.service';

const REPORT_PREFIX = 'reports.monthly.';
const CURSOR_KEY = 'reports.monthly.cursor';
const daySnapshotSchema = z.object({
  workDate: z.string(),
  capturedAt: z.number().int(),
  closedAt: z.number().int().nullable(),
  actual: z.object({ completed: z.number(), cancelled: z.number(), assumedCompleted: z.number() }),
  score: z.object({ score: z.number(), evaluated: z.boolean() }),
  alerts: z.object({ resolved: z.number(), significantTotal: z.number() }),
});

/** Builds frozen or provisional monthly facts and enqueues one dispatcher report per month. */
@Injectable()
export class MonthlyReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
  ) {}

  /** Reads a month; completed months are frozen in AppState, current month is preview-only. */
  async read(month = moscowMonth(this.clock.nowSeconds())): Promise<MonthlyReportData> {
    const now = this.clock.nowSeconds();
    assertMonth(month, moscowMonth(now));
    if (month < moscowMonth(now)) {
      const stored = await this.prisma.appState.findUnique({ where: { key: reportKey(month) } });
      const parsed = stored ? monthlyReportSchema.safeParse(stored.value) : null;
      if (parsed?.success) return parsed.data;
      return this.uow.run((tx) => this.freeze(tx, month, now, false));
    }
    return this.build(this.prisma, month, now, true);
  }

  /** Advances the monthly cursor and catches up closed months without rebuilding frozen data. */
  async catchUp(now = this.clock.nowSeconds()): Promise<{ months: string[] }> {
    const current = moscowMonth(now);
    const result = await this.uow.run(async (tx) => {
      const cursor = await tx.appState.findUnique({ where: { key: CURSOR_KEY } });
      if (!cursor) {
        await tx.appState.create({
          data: { key: CURSOR_KEY, value: { version: 1, month: current }, updatedAt: BigInt(now) },
        });
        return [];
      }
      const value = cursor.value;
      const previous =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        'month' in value &&
        typeof value.month === 'string'
          ? value.month
          : current;
      const months: string[] = [];
      let month = previous;
      while (month < current) {
        await this.freeze(tx, month, now, true);
        months.push(month);
        month = nextMonth(month);
      }
      await tx.appState.upsert({
        where: { key: CURSOR_KEY },
        update: { value: { version: 1, month: current }, updatedAt: BigInt(now) },
        create: { key: CURSOR_KEY, value: { version: 1, month: current }, updatedAt: BigInt(now) },
      });
      return months;
    });
    return { months: result };
  }

  /** Creates a closed report and one deduplicated intent per enabled dispatcher. */
  private async freeze(
    tx: Tx,
    month: string,
    generatedAt: number,
    notify: boolean,
  ): Promise<MonthlyReportData> {
    const key = reportKey(month);
    const existing = await tx.appState.findUnique({ where: { key } });
    const parsed = existing ? monthlyReportSchema.safeParse(existing.value) : null;
    const report = parsed?.success ? parsed.data : await this.build(tx, month, generatedAt, false);
    if (!parsed?.success) {
      const value = report as unknown as Prisma.InputJsonValue;
      // Preserve a valid snapshot if another close/read won the race. A malformed
      // pre-existing value is repaired, while an absent key uses a no-op update path.
      await tx.appState.upsert({
        where: { key },
        update: existing
          ? { value, updatedAt: BigInt(generatedAt) }
          : { updatedAt: BigInt(generatedAt) },
        create: { key, value, updatedAt: BigInt(generatedAt) },
      });
    }
    if (!notify || process.env.DEMO_STAND === 'true') return report;
    const dispatchers = await tx.accountRole.findMany({
      where: { role: 'dispatcher', account: { mailNotificationsEnabled: true } },
      select: { accountId: true },
    });
    for (const dispatcher of dispatchers) {
      await this.notifications.record(tx, generatedAt, {
        category: 'dispatcher_monthly_report' as NotificationCategory,
        businessEventKey: `dispatcher-monthly-report:${month}:${dispatcher.accountId}`,
        recipientAccountId: dispatcher.accountId,
        payload: { month, reportKey: key },
      });
    }
    return report;
  }

  private async build(
    db: PrismaService | Tx,
    month: string,
    generatedAt: number,
    provisional: boolean,
  ): Promise<MonthlyReportData> {
    const [start, end] = moscowMonthBounds(Date.parse(`${month}-15T12:00:00+03:00`) / 1000);
    const rewards = await db.engineerReward.findMany({
      where: { awardedAt: { gte: BigInt(start), lt: BigInt(end) } },
      include: { engineer: { select: { id: true, displayName: true } } },
      orderBy: { awardedAt: 'asc' },
    });
    const facts = await db.requestFact.findMany({
      where: {
        recordedAt: { gte: BigInt(start), lt: BigInt(end) },
        kind: { in: ['started', 'finished'] },
      },
      select: {
        id: true,
        requestId: true,
        engineerId: true,
        kind: true,
        occurredAt: true,
        recordedAt: true,
      },
      orderBy: [{ recordedAt: 'asc' }, { occurredAt: 'asc' }],
    });
    const cancelledRows = await db.request.findMany({
      where: { cancelledAt: { gte: BigInt(start), lt: BigInt(end) } },
      select: { id: true, cancelledAt: true },
    });
    const assumptions = await db.liveRequestState.findMany({
      where: { assumedCompletedAt: { gte: BigInt(start), lt: BigInt(end) } },
      select: { requestId: true },
    });
    const workdayEngineers = await db.engineerDay.findMany({
      where: { workDate: { startsWith: `${month}-` } },
      select: { engineerId: true },
    });
    const allEngineers = await db.engineer.findMany({
      where: { createdAt: { lt: BigInt(end) } },
      select: { id: true, displayName: true, archivedAt: true },
    });
    const engineerIds = new Set<string>(workdayEngineers.map((row) => row.engineerId));
    for (const row of allEngineers)
      if (row.archivedAt === null || Number(row.archivedAt) >= start) engineerIds.add(row.id);
    for (const row of rewards) engineerIds.add(row.engineerId);
    for (const row of facts) if (row.engineerId) engineerIds.add(row.engineerId);
    const engineerRows = allEngineers.filter((row) => engineerIds.has(row.id));
    const names = new Map(engineerRows.map((row) => [row.id, row.displayName]));
    const byEngineer = new Map<
      string,
      {
        points: number;
        earned: number;
        penalty: number;
        completed: number;
        workMinutes: number;
        categories: { arrival: number; completion: number; passport: number; penalty: number };
      }
    >();
    const ensure = (id: string) =>
      byEngineer.get(id) ?? {
        points: 0,
        earned: 0,
        penalty: 0,
        completed: 0,
        workMinutes: 0,
        categories: { arrival: 0, completion: 0, passport: 0, penalty: 0 },
      };
    for (const id of engineerIds) byEngineer.set(id, ensure(id));
    for (const row of rewards) {
      const current = ensure(row.engineerId);
      current.points += row.points;
      current.categories[row.category] += row.points;
      if (row.category === 'penalty') current.penalty += row.points;
      else current.earned += row.points;
      byEngineer.set(row.engineerId, current);
    }
    const completionByRequest = new Set<string>();
    const started = new Map<string, { engineerId: string; at: number }>();
    const completedEngineer = new Map<string, string>();
    for (const fact of facts) {
      if (!fact.engineerId) continue;
      if (fact.kind === 'started')
        started.set(fact.requestId, { engineerId: fact.engineerId, at: Number(fact.occurredAt) });
      if (fact.kind === 'finished' && !completionByRequest.has(fact.requestId)) {
        completionByRequest.add(fact.requestId);
        completedEngineer.set(fact.requestId, fact.engineerId);
        const current = ensure(fact.engineerId);
        current.completed += 1;
        byEngineer.set(fact.engineerId, current);
      }
    }
    const completedRequestIds = [...completionByRequest];
    if (completedRequestIds.length > 0) {
      const earlierStarts = await db.requestFact.findMany({
        where: { requestId: { in: completedRequestIds }, kind: 'started' },
        select: { requestId: true, engineerId: true, occurredAt: true },
        orderBy: { occurredAt: 'asc' },
      });
      for (const fact of earlierStarts) {
        if (fact.engineerId && !started.has(fact.requestId))
          started.set(fact.requestId, { engineerId: fact.engineerId, at: Number(fact.occurredAt) });
      }
      for (const requestId of completedRequestIds) {
        const engineerId = completedEngineer.get(requestId);
        const begin = started.get(requestId);
        if (!engineerId || !begin || begin.engineerId !== engineerId) continue;
        const completionFact = facts.find(
          (fact) => fact.requestId === requestId && fact.kind === 'finished',
        );
        if (!completionFact || Number(completionFact.occurredAt) <= begin.at) continue;
        const current = ensure(engineerId);
        current.workMinutes += Math.round((Number(completionFact.occurredAt) - begin.at) / 60);
        byEngineer.set(engineerId, current);
      }
    }
    const dayRows = await db.appState.findMany({
      where: { key: { startsWith: 'performance.day.' } },
      select: { value: true },
    });
    const days = dayRows
      .flatMap((row) => {
        const parsed = daySnapshotSchema.safeParse(row.value);
        return parsed.success &&
          parsed.data.workDate.startsWith(`${month}-`) &&
          parsed.data.closedAt !== null
          ? [parsed.data]
          : [];
      })
      .sort((a, b) => a.workDate.localeCompare(b.workDate));
    const workdays = await db.liveWorkday.findMany({
      where: { workDate: { startsWith: `${month}-` } },
      select: { workDate: true },
    });
    const notes: string[] = [];
    if (provisional) notes.push('Текущий месяц предварительный и не заморожен.');
    if (rewards.length === 0) notes.push('За период нет строк журнала наград.');
    if (completionByRequest.size === 0)
      notes.push('За период нет подтверждённых фактов завершения.');
    if (workdays.some((day) => !days.some((snapshot) => snapshot.workDate === day.workDate)))
      notes.push(
        'Для части рабочих дней нет сохранённого snapshot производительности; историческая оценка не подменяется.',
      );
    if (days.length === 0) notes.push('Нет завершённых дней с измеренной оценкой диспетчера.');
    const values = [...byEngineer.entries()];
    const totalPoints = values.reduce((sum, [, value]) => sum + value.points, 0);
    const teamAverage = values.length === 0 ? null : totalPoints / values.length;
    const engineers = values
      .map(([engineerId, value]) => ({
        engineerId,
        name: names.get(engineerId) ?? 'Инженер',
        points: value.points,
        earnedPoints: value.earned,
        penaltyPoints: value.penalty,
        ratio: teamAverage !== null && teamAverage > 0 ? value.points / teamAverage : null,
        completed: value.completed,
        workMinutes: value.workMinutes,
        categories: value.categories,
      }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    const coverageStartAt =
      [
        ...rewards.map((row) => Number(row.awardedAt)),
        ...facts.map((row) => Number(row.recordedAt)),
        ...days.map((row) => row.capturedAt),
      ].sort((a, b) => a - b)[0] ?? null;
    return {
      version: 1,
      month,
      generatedAt,
      provisional,
      coverageStartAt,
      totals: {
        completed: completionByRequest.size,
        cancelled: new Set(cancelledRows.map((row) => row.id)).size,
        assumedCompleted: new Set(assumptions.map((row) => row.requestId)).size,
        workMinutes: engineers.reduce((sum, row) => sum + row.workMinutes, 0),
        engineerCount: engineers.length,
        earnedPoints: engineers.reduce((sum, row) => sum + row.earnedPoints, 0),
        penaltyPoints: engineers.reduce((sum, row) => sum + row.penaltyPoints, 0),
        teamAverage,
      },
      engineers,
      days: days.map((day) => ({
        workDate: day.workDate,
        score: day.score.score,
        evaluated: day.score.evaluated,
        completed: day.actual.completed,
        alertsResolved: day.alerts.resolved,
        alertsTotal: day.alerts.significantTotal,
      })),
      notes,
    };
  }
}

/** Validates a civil Moscow month and rejects future months. */
export function assertMonth(month: string, current: string): void {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month))
    throw SysError.validationFailed('month must be YYYY-MM');
  if (month > current) throw SysError.validationFailed('A future month is not available');
}

export function reportKey(month: string): string {
  return `${REPORT_PREFIX}${month}`;
}

function nextMonth(month: string): string {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const value = Number(monthText);
  return value === 12 ? `${year + 1}-01` : `${year}-${String(value + 1).padStart(2, '0')}`;
}
