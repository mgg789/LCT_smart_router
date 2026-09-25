import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { SysError } from '../../common/errors';
import { canonicalHash } from '../../common/json';
import { Clock } from '../../common/time';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../persistence';
import { businessNow } from '../live/business-clock';
import { combineScore, scoreAlertProcessing, scorePolicyChoice } from './scoring';
import type {
  AlertAttribution,
  AlertGroupMetric,
  EngineerPerformanceMetric,
  EngineerPerformanceResponse,
  PerformanceDaySnapshot,
  PolicyComparisonEvidence,
} from './types';

const attributionSchema = z.object({
  version: z.literal(1),
  alertId: z.string(),
  code: z.string(),
  workDate: z.string().nullable(),
  createdAt: z.number().int(),
  firstAction: z
    .object({
      action: z.string(),
      at: z.number().int(),
      actorKind: z.enum(['account', 'api_token', 'system']),
      actorSource: z.enum(['ui', 'external_api', 'ai_run', 'system']),
    })
    .nullable(),
  outcome: z.enum(['pending', 'resolved']),
  resolvedAt: z.number().int().nullable(),
  resolutionReason: z.string().nullable(),
});

const selectionSchema = z.object({
  version: z.literal(1),
  policyId: z.string(),
  operationId: z.string(),
  actorKind: z.enum(['account', 'api_token', 'system']),
  actorSource: z.enum(['ui', 'external_api', 'ai_run', 'system']),
  selectedAt: z.number().int(),
  evidenceKey: z.string().nullable(),
  inputHash: z.string().nullable(),
  routerContextVersion: z.string().nullable(),
  rosterHash: z.string().nullable(),
});

const policyEvidenceSchema = z.object({
  version: z.literal(1),
  inputPublicationId: z.string(),
  inputHash: z.string(),
  routerContextVersion: z.string(),
  rosterHash: z.string(),
  rosterEngineerIds: z.array(z.string()),
  computedAt: z.number().int(),
  searchBudgetMs: z.number().int(),
  rows: z.array(
    z.object({
      strategyId: z.string(),
      kind: z.enum(['policy', 'baseline']),
      additionalEngineers: z.number().int(),
      isUsable: z.boolean(),
      calculationMs: z.number().int(),
      metrics: z.object({
        requestsTotal: z.number().int(),
        assignedCount: z.number().int(),
        unassignedCount: z.number().int(),
        urgentTotal: z.number().int(),
        urgentAssignedCount: z.number().int(),
        engineersUsed: z.number().int(),
        distanceKm: z.number(),
        travelTimeSec: z.number().int(),
        workTimeSec: z.number().int(),
        waitingTimeSec: z.number().int(),
        lunchTimeSec: z.number().int(),
        lateAssignedCount: z.number().int(),
        totalLatenessSec: z.number().int(),
        minWindowSlackSec: z.number().int().nullable(),
        workloadSpreadSec: z.number().int(),
        maxWorkloadSec: z.number().int(),
      }),
    }),
  ),
  savedAt: z.number().int(),
});

const snapshotSchema = z.object({
  version: z.literal(1),
  workdayId: z.string(),
  workDate: z.string(),
  capturedAt: z.number().int(),
  closedAt: z.number().int().nullable(),
  engineerCount: z.number().int(),
  actual: z.object({
    completed: z.number().int(),
    cancelled: z.number().int(),
    assumedCompleted: z.number().int(),
  }),
  workMinutes: z.number().int(),
  engineers: z.array(
    z.object({
      engineerId: z.string(),
      completed: z.number().int(),
      cancelled: z.number().int(),
      assumedCompleted: z.number().int(),
      workMinutes: z.number().int(),
    }),
  ),
  alerts: z.object({
    significantTotal: z.number().int(),
    resolved: z.number().int(),
    unresolved: z.number().int(),
    groups: z.array(
      z.object({
        code: z.string(),
        total: z.number().int(),
        resolved: z.number().int(),
        unresolved: z.number().int(),
      }),
    ),
  }),
  policy: z.object({
    selectedPolicyId: z.string().nullable(),
    evidence: policyEvidenceSchema.nullable(),
    measured: z.boolean(),
    score: z.number().int(),
    explanation: z.string(),
  }),
  score: z.object({
    score: z.number().int(),
    evaluated: z.boolean(),
    alertProcessing: z.object({
      score: z.number(),
      weight: z.number(),
      evaluated: z.boolean(),
      explanation: z.string(),
    }),
    policyChoice: z.object({
      score: z.number(),
      weight: z.number(),
      evaluated: z.boolean(),
      explanation: z.string(),
    }),
    explanation: z.array(z.string()),
  }),
});

/** AppState namespace for immutable dispatcher performance facts. */
export const PERFORMANCE_DAY_PREFIX = 'performance.day.';
export const PERFORMANCE_ALERT_PREFIX = 'performance.alert.';
export const PERFORMANCE_POLICY_SELECTION_PREFIX = 'performance.policy-selection.';
export const PERFORMANCE_POLICY_COMPARISON_PREFIX = 'performance.policy-comparison.';

/** Returns whether a policy choice belongs to this logical workday snapshot. */
export function isSelectionInDay(
  selectedAt: number,
  dayStartAt: number,
  capturedAt: number,
): boolean {
  return selectedAt >= dayStartAt && selectedAt <= capturedAt;
}

/**
 * Builds and reads durable day analytics without adding a schema table.
 * A snapshot is written once at explicit close and remains the source for later reports.
 */
@Injectable()
export class PerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Returns the frozen close snapshot, or a truthful live preview before close. */
  async day(workdayId: string): Promise<PerformanceDaySnapshot> {
    const workday = await this.prisma.liveWorkday.findUnique({ where: { id: workdayId } });
    if (!workday) throw SysError.notFound('Live workday', { workdayId });
    const stored = await this.prisma.appState.findUnique({
      where: { key: `${PERFORMANCE_DAY_PREFIX}${workdayId}` },
    });
    const parsed = stored ? snapshotSchema.safeParse(stored.value) : null;
    if (parsed?.success) return parsed.data;
    return this.buildSnapshot(
      this.prisma,
      workdayId,
      await businessNow(this.prisma, this.clock.nowSeconds(), workday.workDate),
      null,
    );
  }

  /** Exposes only the authenticated engineer's metrics; team evidence stays dispatcher-only. */
  async engineerDay(workdayId: string, engineerId: string): Promise<EngineerPerformanceResponse> {
    const performance = await this.day(workdayId);
    return {
      workdayId: performance.workdayId,
      workDate: performance.workDate,
      closedAt: performance.closedAt,
      engineer: performance.engineers.find((item) => item.engineerId === engineerId) ?? null,
    };
  }

  /** Persists the first close snapshot inside the same transaction as ShiftClosure. */
  async snapshotIn(tx: Tx, workdayId: string, closedAt: number): Promise<PerformanceDaySnapshot> {
    const key = `${PERFORMANCE_DAY_PREFIX}${workdayId}`;
    const existing = await tx.appState.findUnique({ where: { key } });
    const parsed = existing ? snapshotSchema.safeParse(existing.value) : null;
    if (parsed?.success) return parsed.data;
    const snapshot = await this.buildSnapshot(tx, workdayId, closedAt, closedAt);
    await tx.appState.create({
      data: {
        key,
        value: snapshot as unknown as Prisma.InputJsonValue,
        updatedAt: BigInt(closedAt),
      },
    });
    return snapshot;
  }

  /** Builds a live preview from explicit facts and durable attribution rows. */
  async buildSnapshot(
    db: PrismaService | Tx,
    workdayId: string,
    capturedAt: number,
    closedAt: number | null,
  ): Promise<PerformanceDaySnapshot> {
    const workday = await db.liveWorkday.findUnique({ where: { id: workdayId } });
    if (!workday) throw SysError.notFound('Live workday', { workdayId });
    const start = Number(workday.logicalStartAt);
    const end = Number(workday.logicalEndAt);
    const states = await db.liveRequestState.findMany({
      where: { workdayId },
      select: { requestId: true, assumedCompletedAt: true, reservedEngineerId: true },
    });
    const stateByRequest = new Map(states.map((state) => [state.requestId, state]));
    const requestIds = [...stateByRequest.keys()];
    const requests = await db.request.findMany({
      where: {
        OR: [
          ...(requestIds.length > 0 ? [{ id: { in: requestIds } }] : []),
          { completedAt: { gte: BigInt(start), lte: BigInt(end) } },
          { cancelledAt: { gte: BigInt(start), lte: BigInt(end) } },
        ],
      },
      select: { id: true, lifecycle: true, completedAt: true, cancelledAt: true },
    });
    const facts = await db.requestFact.findMany({
      where: {
        occurredAt: { gte: BigInt(start), lte: BigInt(end) },
        kind: { in: ['started', 'finished'] },
      },
      select: { requestId: true, engineerId: true, kind: true, occurredAt: true },
      orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }],
    });
    const days = await db.engineerDay.findMany({
      where: { workDate: workday.workDate },
      select: { engineerId: true },
    });
    const engineerIds = new Set(days.map((day) => day.engineerId));
    for (const fact of facts) if (fact.engineerId) engineerIds.add(fact.engineerId);
    for (const state of states)
      if (state.reservedEngineerId) engineerIds.add(state.reservedEngineerId);

    const metricByEngineer = new Map<string, EngineerPerformanceMetric>();
    for (const engineerId of engineerIds) {
      metricByEngineer.set(engineerId, {
        engineerId,
        completed: 0,
        cancelled: 0,
        assumedCompleted: 0,
        workMinutes: 0,
      });
    }
    const engineerForRequest = new Map<string, string>();
    const started = new Map<string, { engineerId: string; at: number }>();
    for (const fact of facts) {
      if (!fact.engineerId) continue;
      engineerForRequest.set(fact.requestId, fact.engineerId);
      if (fact.kind === 'started')
        started.set(fact.requestId, { engineerId: fact.engineerId, at: Number(fact.occurredAt) });
      if (fact.kind === 'finished') {
        const begin = started.get(fact.requestId);
        if (begin && Number(fact.occurredAt) > begin.at) {
          const metric = metricByEngineer.get(begin.engineerId);
          if (metric)
            metricByEngineer.set(begin.engineerId, {
              ...metric,
              workMinutes:
                metric.workMinutes + Math.round((Number(fact.occurredAt) - begin.at) / 60),
            });
        }
      }
    }
    let completed = 0;
    let cancelled = 0;
    let assumedCompleted = 0;
    for (const request of requests) {
      const engineerId =
        engineerForRequest.get(request.id) ??
        stateByRequest.get(request.id)?.reservedEngineerId ??
        null;
      if (
        request.lifecycle === 'completed' &&
        request.completedAt !== null &&
        Number(request.completedAt) >= start &&
        Number(request.completedAt) <= end
      ) {
        completed += 1;
        if (engineerId) {
          const metric = metricByEngineer.get(engineerId);
          if (metric)
            metricByEngineer.set(engineerId, { ...metric, completed: metric.completed + 1 });
        }
      }
      if (
        request.lifecycle === 'cancelled' &&
        request.cancelledAt !== null &&
        Number(request.cancelledAt) >= start &&
        Number(request.cancelledAt) <= end
      ) {
        cancelled += 1;
        if (engineerId) {
          const metric = metricByEngineer.get(engineerId);
          if (metric)
            metricByEngineer.set(engineerId, { ...metric, cancelled: metric.cancelled + 1 });
        }
      }
    }
    for (const state of states) {
      if (
        state.assumedCompletedAt === null ||
        Number(state.assumedCompletedAt) < start ||
        Number(state.assumedCompletedAt) > end
      )
        continue;
      assumedCompleted += 1;
      const engineerId = state.reservedEngineerId ?? engineerForRequest.get(state.requestId);
      if (engineerId) {
        const metric = metricByEngineer.get(engineerId);
        if (metric)
          metricByEngineer.set(engineerId, {
            ...metric,
            assumedCompleted: metric.assumedCompleted + 1,
          });
      }
    }

    const alerts = await db.alert.findMany({
      where: {
        OR: [
          { workDate: workday.workDate },
          { createdAt: { gte: BigInt(start), lte: BigInt(end) } },
        ],
      },
      select: {
        id: true,
        kind: true,
        isBlocking: true,
        code: true,
        invalidatedAt: true,
        resolutionAction: true,
      },
    });
    const significant = alerts.filter(
      (alert) =>
        alert.kind === 'alert' &&
        alert.isBlocking &&
        alert.invalidatedAt === null &&
        alert.resolutionAction !== 'superseded' &&
        alert.resolutionAction !== 'system_expired',
    );
    const attributions = await db.appState.findMany({
      where: { key: { startsWith: PERFORMANCE_ALERT_PREFIX } },
      select: { value: true },
    });
    const attributionValues: AlertAttribution[] = attributions.flatMap((row) => {
      const parsed = attributionSchema.safeParse(row.value);
      return parsed.success ? [parsed.data] : [];
    });
    const significantIds = new Set(significant.map((alert) => alert.id));
    const resolvedIds = new Set(
      attributionValues
        .filter((item) => significantIds.has(item.alertId) && item.outcome === 'resolved')
        .map((item) => item.alertId),
    );
    const groups = new Map<string, AlertGroupMetric>();
    for (const alert of significant) {
      const resolved = resolvedIds.has(alert.id);
      const current = groups.get(alert.code) ?? {
        code: alert.code,
        total: 0,
        resolved: 0,
        unresolved: 0,
      };
      groups.set(alert.code, {
        ...current,
        total: current.total + 1,
        resolved: current.resolved + (resolved ? 1 : 0),
        unresolved: current.unresolved + (resolved ? 0 : 1),
      });
    }

    const rosterEngineerIds = [...engineerIds].sort();
    const rosterHash = canonicalHash(rosterEngineerIds);
    const selectionRows = await db.appState.findMany({
      where: { key: { startsWith: PERFORMANCE_POLICY_SELECTION_PREFIX } },
      select: { value: true },
    });
    const selections = selectionRows
      .flatMap((row) => {
        const parsed = selectionSchema.safeParse(row.value);
        return parsed.success && isSelectionInDay(parsed.data.selectedAt, start, capturedAt)
          ? [parsed.data]
          : [];
      })
      .sort((left, right) => right.selectedAt - left.selectedAt);
    const selection = selections[0] ?? null;
    let evidence: PolicyComparisonEvidence | null = null;
    if (selection?.evidenceKey) {
      const evidenceRow = await db.appState.findUnique({ where: { key: selection.evidenceKey } });
      const parsed = evidenceRow ? policyEvidenceSchema.safeParse(evidenceRow.value) : null;
      if (parsed?.success && parsed.data.rosterHash === rosterHash) evidence = parsed.data;
    }
    const policyChoice = scorePolicyChoice(evidence, selection?.policyId ?? null);
    const alertProcessing = scoreAlertProcessing(attributionValues, significantIds);
    const score = combineScore(alertProcessing, policyChoice);
    return {
      version: 1,
      workdayId,
      workDate: workday.workDate,
      capturedAt,
      closedAt,
      engineerCount: engineerIds.size,
      actual: { completed, cancelled, assumedCompleted },
      workMinutes: [...metricByEngineer.values()].reduce((sum, item) => sum + item.workMinutes, 0),
      engineers: [...metricByEngineer.values()].sort((left, right) =>
        left.engineerId.localeCompare(right.engineerId),
      ),
      alerts: {
        significantTotal: significant.length,
        resolved: resolvedIds.size,
        unresolved: significant.length - resolvedIds.size,
        groups: [...groups.values()].sort((left, right) => left.code.localeCompare(right.code)),
      },
      policy: {
        selectedPolicyId: selection?.policyId ?? null,
        evidence,
        measured: policyChoice.evaluated,
        score: policyChoice.score,
        explanation: policyChoice.explanation,
      },
      score,
    };
  }

  /** Computes the base roster hash used by policy evidence and tests. */
  static rosterHash(engineerIds: readonly string[]): string {
    return canonicalHash([...engineerIds].sort());
  }
}
