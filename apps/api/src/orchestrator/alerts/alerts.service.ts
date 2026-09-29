import { randomUUID } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { zonedWallUnix } from '../../common/time/zone';
import { assertEmergencyWindowUnchanged } from '../requests/requests.service';
import { lunchCoverageWitness, policyCoverageRegressed } from './coverage-policy';

export { lunchCoverageWitness, policyCoverageRegressed } from './coverage-policy';

import type { Actor } from '../../auth';
import { SysError } from '../../common/errors';
import { canonicalHash } from '../../common/json';
import { Clock } from '../../common/time';
import { Prisma } from '../../generated/prisma/client';
import { NotificationsService } from '../../notifications';
import type { OperationContext } from '../../operations';
import { OperationsService } from '../../operations';
import {
  lockAlertQueue,
  lockRoutingCurrent,
  PrismaService,
  type Tx,
  UnitOfWork,
} from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { readManualState, writeManualState } from '../../routing/router-gateway/manual-state';
import { RouterClient } from '../../routing/router-gateway/router-client.port';
import { MiniAiService } from '../ai/mini-ai.service';
import {
  DEFAULT_EXECUTION_TIMING_POLICY,
  ExecutionTimingPolicy,
} from '../facts/execution-timing-policy';
import { businessNow } from '../live/business-clock';
import { PERFORMANCE_ALERT_PREFIX, PerformanceService } from '../performance';
import { readRequestPriority, requestPriorityKey } from '../policy/request-priority';
import { requireWindowConfirmation } from '../requests/window-confirmation';
import { DispatcherSettingsService } from '../settings/dispatcher-settings.service';
import { buildAlertBrief } from './alert-brief';
import { type AlertAction, alertActionsFor, resolutionDelay } from './alert-policy';
import { type AlertView, toAlertView } from './alert-view';
import { AlertWindowQuery } from './alert-window-query';

/** Router's immutable comparison evidence for one manual plan on one exact input. */
const manualEvaluationSchema = z.object({
  input_hash: z.string().min(1),
  router_context_version: z.string().min(1),
  policy_id: z.string().min(1),
  feasible: z.boolean(),
  degraded: z.boolean(),
  criterion: z.string().nullable(),
  before: z.array(z.number()),
  after: z.array(z.number()).nullable(),
});

/** Cached only by immutable plan, input and Router-context identity. */
const manualEvidenceSchema = z.object({
  identity: z.string().min(1),
  planId: z.string().min(1),
  inputHash: z.string().min(1),
  evaluation: manualEvaluationSchema.nullable(),
});

export interface ResolveAlertInput {
  readonly action: AlertAction;
  readonly expectedPriorityVersion?: string;
  readonly reason?: string;
  readonly minutes?: number;
  readonly windowStartAt?: number;
  readonly windowEndAt?: number;
  readonly expectedRequestVersion?: number;
  readonly engineerId?: string;
}

export type { AlertView } from './alert-view';

/**
 * Durable dispatcher decision queue.
 *
 * Timers only detect a condition. They never change a route, remove an engineer or
 * resolve a request. A dispatcher operation is the sole path that closes an alert.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly publisher: SnapshotPublisher,
    private readonly notifications: NotificationsService,
    private readonly router: RouterClient,
    private readonly operations: OperationsService,
    private readonly miniAi: MiniAiService,
    private readonly windowQuery: AlertWindowQuery,
    @Optional() private readonly timing?: ExecutionTimingPolicy,
    @Optional() private readonly dispatcherSettings?: DispatcherSettingsService,
    @Optional() private readonly performance?: PerformanceService,
  ) {}

  /** Read the exact priority revision that the dispatcher must confirm before replacement. */
  priority(workDate: string) {
    return readRequestPriority(this.prisma, workDate);
  }

  private readonly windowCache = new Map<
    string,
    { expiresAt: number; value: ReturnType<RouterClient['proposeWindow']> }
  >();

  /** Builds a fresh, unpublished preview; network work never holds a DB transaction. */
  async proposeWindow(id: string) {
    const prepared = await this.windowQuery.prepare(id);
    const key = canonicalHash(prepared.input);
    const cached = this.windowCache.get(key);
    let value = cached && cached.expiresAt > Date.now() ? cached.value : null;
    if (!value) {
      if (this.windowCache.size >= 32) this.windowCache.clear();
      value = this.router.proposeWindow(prepared.input);
      this.windowCache.set(key, { expiresAt: Date.now() + 10_000, value });
      value.catch(() => this.windowCache.delete(key));
    }
    const result = await value;
    if (
      (await this.windowQuery.prepare(id, prepared.input.snapshot.planning_as_of)).identity !==
      prepared.identity
    )
      throw new SysError(
        'VALIDATION_FAILED',
        'The plan changed while calculating; request a fresh window',
      );
    return { ...result, requestVersion: prepared.requestVersion };
  }

  /**
   * System one picks an allowed action for the alert; the usual resolve applies it.
   *
   * Both the dashboard endpoint and the MCP tool call this one handler, so the choice of
   * what an automated resolver may do lives in exactly one place: an already handled alert
   * is refused, a window move uses only a Router proposal (or is left out when today has
   * none), and the applied action is a journalled `alert.resolve` operation.
   */
  async resolveWithSystemOne(
    actor: Actor,
    id: string,
    options?: { apply?: boolean },
  ): Promise<{
    alert: AlertView;
    choice: string;
    applied: boolean;
    engineerId: string | null;
    minutes: number | null;
    windowStartAt: number | null;
    windowEndAt: number | null;
    expectedRequestVersion: number | null;
  }> {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (alert?.kind !== 'alert' || alert.resolvedAt !== null) {
      throw SysError.validationFailed('Этот алерт уже нельзя разобрать.');
    }
    const brief = await buildAlertBrief(this.prisma, (id) => this.proposeWindow(id), alert);
    const choice = await this.miniAi.chooseAlert({
      summary: brief.summary,
      actions: brief.actions,
      engineers: brief.engineers,
      windows: brief.windows,
      minutes: brief.minutes,
    });
    const action = brief.actions.find((item) => item === choice.action);
    if (!action) {
      throw SysError.validationFailed('Модель выбрала действие вне списка.');
    }
    const picked = {
      choice: choice.action,
      engineerId: choice.engineerId ?? null,
      minutes: choice.minutes ?? null,
      windowStartAt: action === 'move_window' ? (choice.windowStartAt ?? null) : null,
      windowEndAt: action === 'move_window' ? (choice.windowEndAt ?? null) : null,
      expectedRequestVersion: action === 'move_window' ? brief.requestVersion : null,
    };
    // Window proposals are always preview-only here: a second model call must not
    // replace the exact proposal the human saw while confirming the explicit resolve.
    if (options?.apply === false || action === 'move_window' || action === 'reschedule') {
      return { alert: toAlertView(alert), ...picked, applied: false };
    }
    const operationId = randomUUID();
    const dto = {
      operationId,
      action,
      reason: choice.reason,
      ...(picked.engineerId ? { engineerId: picked.engineerId } : {}),
      ...(picked.minutes ? { minutes: picked.minutes } : {}),
      ...(picked.windowStartAt !== null && picked.windowEndAt !== null
        ? {
            windowStartAt: picked.windowStartAt,
            windowEndAt: picked.windowEndAt,
            expectedRequestVersion: picked.expectedRequestVersion ?? undefined,
          }
        : {}),
    };
    const outcome = await this.operations.execute(
      { operationId, actor, action: 'alert.resolve', targetRef: id, payload: dto },
      (context) => this.resolve(context, id, dto),
    );
    return { alert: outcome.result, ...picked, applied: true };
  }

  private async thresholds(db: PrismaService | Tx = this.prisma) {
    if (!this.dispatcherSettings) {
      return {
        noShowSec: 30 * 60,
        overdueSec: 5 * 60,
        timeRiskSec: 5 * 60,
        repeatAfterSec: 15 * 60,
      };
    }
    return this.dispatcherSettings.read(db);
  }

  /** Refreshes timer-derived conditions before a dashboard reads the queue. */
  async list(workDate?: string): Promise<AlertView[]> {
    await this.evaluateManualPlan();
    await this.uow.run((tx) => this.refresh(tx, this.clock.nowSeconds(), workDate));
    const scope = workDate ? { workDate } : {};
    // Open work is never hidden by an arbitrarily long resolved history.
    const [open, history] = await Promise.all([
      this.prisma.alert.findMany({
        where: { ...scope, resolvedAt: null, invalidatedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.alert.findMany({
        where: { ...scope, OR: [{ resolvedAt: { not: null } }, { invalidatedAt: { not: null } }] },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    ]);
    const alerts = [...open, ...history];
    const emergencies = new Set(
      (
        await this.prisma.request.findMany({
          where: {
            id: { in: alerts.flatMap((alert) => alert.requestIds) },
            workCategory: 'emergency',
          },
          select: { id: true },
        })
      ).map((request) => request.id),
    );
    return alerts.map((alert) =>
      toAlertView(
        alert,
        alert.requestIds.some((id) => emergencies.has(id)),
      ),
    );
  }

  /** Used by the coordinator; no dashboard request is required for alert creation. */
  async refreshAll(): Promise<void> {
    await this.evaluateManualPlan();
    const now = this.clock.nowSeconds();
    await this.uow.run((tx) => this.refresh(tx, now));
  }

  /** Calculates manual costs outside database transactions, caching only exact identities. */
  private async evaluateManualPlan(): Promise<void> {
    const pointer = await this.prisma.appliedPlanCurrent.findUnique({
      where: { id: 'singleton' },
      include: {
        plan: { include: { routes: { include: { stops: { orderBy: { sequence: 'asc' } } } } } },
      },
    });
    if (pointer?.plan.origin !== 'manual') return;
    const input = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    if (!input) return;
    let contextVersion: string | null = null;
    try {
      contextVersion = await this.router.getActiveContextVersion();
    } catch {
      /* The review alert below records unavailable evaluation. */
    }
    const identity = `${pointer.plan.id}:${input.snapshot.inputHash}:${contextVersion}`;
    const previous = await this.prisma.appState.findUnique({
      where: { key: 'alerts.manual-evaluation' },
    });
    const saved = manualEvidenceSchema.safeParse(previous?.value);
    if (saved.success && saved.data.identity === identity && saved.data.evaluation !== null) return;
    let evaluation: z.infer<typeof manualEvaluationSchema> | null = null;
    if (contextVersion) {
      try {
        const snapshot = z
          .object({
            requests: z.array(z.object({ request_id: z.string() })),
            engineers: z.array(z.object({ engineer_id: z.string() })),
          })
          .parse(JSON.parse(input.snapshot.payload));
        const requestIds = new Set(snapshot.requests.map((request) => request.request_id));
        const engineerIds = new Set(snapshot.engineers.map((engineer) => engineer.engineer_id));
        const routes: Record<string, string[]> = {};
        for (const route of pointer.plan.routes) {
          const jobs = route.stops.flatMap((stop) =>
            stop.kind === 'job' && stop.requestId && requestIds.has(stop.requestId)
              ? [stop.requestId]
              : [],
          );
          if (jobs.length || engineerIds.has(route.engineerId)) routes[route.engineerId] = jobs;
        }
        const result = await this.router.evaluateManual({
          input_hash: input.snapshot.inputHash,
          router_context_version: contextVersion,
          routes,
        });
        if (
          result.input_hash === input.snapshot.inputHash &&
          result.router_context_version === contextVersion
        )
          evaluation = result;
      } catch {
        /* Never use copied/stale costs to claim objective degradation. */
      }
    }
    await this.uow.run(async (tx) => {
      await lockAlertQueue(tx);
      const current = await tx.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } });
      const publication = await tx.routingCurrent.findUnique({ where: { id: 'singleton' } });
      if (current?.planId !== pointer.plan.id || publication?.snapshotId !== input.snapshotId)
        return;
      const now = this.clock.nowSeconds();
      const value = {
        identity,
        planId: pointer.plan.id,
        inputHash: input.snapshot.inputHash,
        evaluation,
      };
      await tx.appState.upsert({
        where: { key: 'alerts.manual-evaluation' },
        create: { key: 'alerts.manual-evaluation', value, updatedAt: BigInt(now) },
        update: { value, updatedAt: BigInt(now) },
      });
    });
  }

  /** Snapshot apply calls this in its existing transaction for Router-originated alerts. */
  async ingestRouter(
    tx: Tx,
    now: number,
    input: {
      readonly id: string;
      readonly code: string;
      readonly severity: 'info' | 'warning' | 'error';
      readonly engineerIds: string[];
      readonly requestIds: string[];
      readonly reasons: object;
      readonly restoreOption: object | null;
      readonly sourceResultId: string | null;
      readonly workDate: string | null;
    },
  ): Promise<void> {
    await lockAlertQueue(tx);
    const liveDay = await tx.liveWorkday.findFirst({
      where: { status: 'running' },
      orderBy: { startedAtWallSec: 'desc' },
      select: { id: true },
    });
    const code = canonicalRouterCode(input.code);
    if (liveDay && ['time_risk', 'unassigned'].includes(code)) return;
    const workDate = input.workDate ?? (await this.workDateForEngineer(tx, input.engineerIds[0]));
    now = await businessNow(tx, now, workDate ?? undefined);
    if (liveDay && code === 'lunch_conflict') {
      const witness = lunchCoverageWitness(input.reasons);
      const day = input.engineerIds[0]
        ? await tx.engineerDay.findUnique({
            where: {
              engineerId_workDate: {
                engineerId: input.engineerIds[0],
                workDate: workDate ?? '',
              },
            },
            select: { availability: true, lunchTaken: true, lunchWindowEndAt: true },
          })
        : null;
      if (
        !witness ||
        witness.lunch_start_at <= now ||
        !day ||
        day.availability !== 'online' ||
        day.lunchTaken ||
        (day.lunchWindowEndAt !== null && now >= Number(day.lunchWindowEndAt))
      )
        return;
    }
    // Router reuses e.g. lunch:{engineer} across dates. A condition, not a transient
    // result id, is the durable identity of the alert episode.
    const conditionKey = `router:${code}:${workDate ?? 'unknown'}:${[...input.engineerIds].sort().join(',')}:${[...input.requestIds].sort().join(',')}`;
    const existing = await tx.alert.findFirst({
      where: {
        OR: [{ dedupKey: conditionKey }, { dedupKey: { startsWith: `${conditionKey}:episode:` } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing?.invalidatedAt === null) {
      await tx.alert.update({
        where: { id: existing.id },
        data: { sourceResultId: input.sourceResultId },
      });
      return;
    }
    const dedupKey = existing
      ? `${conditionKey}:episode:${input.sourceResultId ?? now}`
      : conditionKey;
    await tx.alert.create({
      data: {
        dedupKey,
        kind: alertActionsFor(code).length === 0 ? 'notice' : 'alert',
        code,
        severity: input.severity,
        engineerIds: input.engineerIds,
        requestIds: input.requestIds,
        reasons: input.reasons,
        restoreOption: input.restoreOption ?? Prisma.DbNull,
        sourceResultId: input.sourceResultId,
        workDate,
        isBlocking: alertActionsFor(code).length > 0,
        createdAt: BigInt(now),
      },
    });
  }

  /** A newer applied Router result makes absent, still-open Router conditions stale. */
  async invalidateOtherRouterConditions(
    tx: Tx,
    now: number,
    resultId: string | null,
  ): Promise<void> {
    if (!resultId) return;
    await tx.alert.updateMany({
      where: {
        dedupKey: { startsWith: 'router:' },
        sourceResultId: { not: resultId },
        resolvedAt: null,
        invalidatedAt: null,
        OR: [{ resolutionAction: null }, { resolutionAction: { not: 'move_window' } }],
      },
      data: { invalidatedAt: BigInt(now), resolvedAt: BigInt(now), resolutionAction: 'superseded' },
    });
    await tx.alert.updateMany({
      where: {
        dedupKey: { startsWith: 'router:' },
        sourceResultId: { not: resultId },
        resolvedAt: { not: null },
        invalidatedAt: null,
      },
      data: { invalidatedAt: BigInt(now) },
    });
  }

  /** A plan application is visible as a notification but can never hold up the shift. */
  async recordPlanRebuilt(tx: Tx, now: number, resultId: string | null): Promise<void> {
    now = await businessNow(tx, now);
    const dedupKey = `notice:plan_rebuilt:${resultId ?? now}`;
    if (!(await tx.alert.findUnique({ where: { dedupKey } }))) {
      await tx.alert.create({
        data: {
          kind: 'notice',
          dedupKey,
          code: 'plan_rebuilt',
          severity: 'info',
          engineerIds: [],
          requestIds: [],
          reasons: { resultId },
          isBlocking: false,
          sourceResultId: resultId,
          createdAt: BigInt(now),
        },
      });
    }
    await this.evaluatePolicyCoverage(tx, now, resultId);
  }

  /** Raises coverage degradation only for the automatic result following a policy change. */
  private async evaluatePolicyCoverage(
    tx: Tx,
    now: number,
    resultId: string | null,
  ): Promise<void> {
    const row = await tx.appState.findUnique({ where: { key: 'alerts.policy-coverage-baseline' } });
    if (!row || !resultId) return;
    const baseline = z
      .object({
        requestIds: z.array(z.string()),
        policyId: z.string(),
        policyVersion: z.number().int(),
        operationId: z.string(),
        workDate: z.string().nullable(),
        expiresAt: z.number().nullable(),
      })
      .safeParse(row.value);
    if (!baseline.success) return;
    if (baseline.data.expiresAt !== null && now > baseline.data.expiresAt) {
      await tx.appState.delete({ where: { key: row.key } });
      return;
    }
    const current = await tx.appliedPlanCurrent.findUnique({
      where: { id: 'singleton' },
      include: { plan: { include: { routerResult: true, assignments: true } } },
    });
    if (!current?.plan.routerResult || current.plan.routerResult.resultId !== resultId) return;
    const payload = current.plan.routerResult.payload;
    const publishedPolicy =
      payload && typeof payload === 'object' && !Array.isArray(payload) && 'policy_id' in payload
        ? String((payload as { policy_id: unknown }).policy_id)
        : null;
    if (publishedPolicy !== baseline.data.policyId) return;
    const activePolicy = await tx.activePolicy.findUnique({ where: { id: 'singleton' } });
    if (
      activePolicy?.policyId !== baseline.data.policyId ||
      activePolicy.version !== baseline.data.policyVersion
    )
      return;
    const submitted = await tx.request.findMany({
      where: { id: { in: baseline.data.requestIds }, lifecycle: 'submitted' },
      select: { id: true },
    });
    const currentAssigned = new Set(
      current.plan.assignments
        .filter((assignment) => assignment.status === 'assigned')
        .map((assignment) => assignment.requestId),
    );
    await tx.appState.delete({ where: { key: row.key } });
    const newSubmittedAssignedIds = submitted
      .map((request) => request.id)
      .filter((id) => currentAssigned.has(id));
    if (
      !policyCoverageRegressed(
        submitted.map((request) => request.id),
        newSubmittedAssignedIds,
      )
    )
      return;
    const lost = submitted.map((request) => request.id).filter((id) => !currentAssigned.has(id));
    const key = `system:plan_degraded:policy:${baseline.data.policyVersion}:${resultId}`;
    await this.ensure(tx, now, {
      key,
      code: 'plan_degraded',
      severity: 'warning',
      engineerIds: [],
      requestIds: lost,
      workDate: baseline.data.workDate,
      reasons: {
        policyId: baseline.data.policyId,
        policyVersion: baseline.data.policyVersion,
        operationId: baseline.data.operationId,
        baselineAssignedRequestIds: baseline.data.requestIds,
        lostSubmittedRequestIds: lost,
        text: `После смены политики ${lost.length} из ${baseline.data.requestIds.length} ранее назначенных заявок потеряли исполнителя. Проверьте новую политику или прошлый план; неназначенные заявки требуют отдельного решения.`,
        expiresAt: baseline.data.expiresAt,
      },
    });
  }

  async markSeen(id: string, now: number): Promise<void> {
    await this.prisma.alert.updateMany({
      where: { id, seenAt: null },
      data: { seenAt: BigInt(now) },
    });
  }

  async resolve(
    context: OperationContext,
    id: string,
    input: ResolveAlertInput,
  ): Promise<AlertView> {
    await lockAlertQueue(context.tx);
    await this.refresh(context.tx, context.now, undefined, context.businessTime);
    if (!context.businessTime)
      context = { ...context, now: await businessNow(context.tx, context.now), businessTime: true };
    const alert = await context.tx.alert.findUnique({ where: { id } });
    if (!alert) throw SysError.notFound('Alert', { alertId: id });
    if (alert.kind !== 'alert') {
      throw new SysError('VALIDATION_FAILED', 'A notice has no resolution action');
    }
    if (alert.resolvedAt !== null || alert.invalidatedAt !== null) return toAlertView(alert);
    const actions = alertActionsFor(alert.code);
    if (!actions.includes(input.action)) {
      throw new SysError('VALIDATION_FAILED', 'This action is not available for the alert', {
        details: { code: alert.code, action: input.action, actions },
      });
    }
    await this.applyAction(context, alert, input);
    if (
      input.action === 'restore_auto' ||
      input.action === 'move_window' ||
      input.action === 'prioritize'
    ) {
      // Saving a window or requesting AUTO is not proof of a feasible assignment.
      // Keep the blocker until a subsequent accepted plan confirms the outcome.
      const pending = await context.tx.alert.update({
        where: { id },
        data: {
          resolutionAction: input.action,
          resolutionReason: input.reason ?? null,
        },
      });
      await recordAlertAttribution(context.tx, context.now, alert, context.actor, input, false);
      return toAlertView(pending);
    }
    const elapsed = context.now - Number(alert.createdAt);
    const resolved = await context.tx.alert.update({
      where: { id },
      data: {
        resolvedAt: BigInt(context.now),
        resolutionAction: input.action,
        resolutionReason: input.reason ?? null,
        // The first three minutes are normal dispatcher thinking time, not a penalty.
        resolutionDelaySec: resolutionDelay(elapsed),
      },
    });
    await recordAlertAttribution(context.tx, context.now, alert, context.actor, input, true);
    return toAlertView(resolved);
  }

  async shiftStatus(
    workDate: string,
  ): Promise<{ workDate: string; closedAt: number | null; unresolvedCount: number }> {
    await this.evaluateManualPlan();
    await this.uow.run((tx) => this.refresh(tx, this.clock.nowSeconds(), workDate));
    const [closure, unresolvedCount] = await Promise.all([
      this.prisma.shiftClosure.findUnique({ where: { workDate } }),
      this.prisma.alert.count({
        // Closing any shift is a dispatcher-level finalisation: an unresolved decision
        // cannot be hidden behind a date filter or an unknown Router work date.
        where: { kind: 'alert', isBlocking: true, resolvedAt: null, invalidatedAt: null },
      }),
    ]);
    return { workDate, closedAt: closure ? Number(closure.closedAt) : null, unresolvedCount };
  }

  async closeShift(
    context: OperationContext,
    workDate: string,
  ): Promise<{ workDate: string; closedAt: number; unresolvedCount: number }> {
    const workday = await context.tx.liveWorkday.findFirst({
      where: { workDate, status: { in: ['pending', 'running', 'finished'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    if (workday && workday.status !== 'finished') {
      throw new SysError(
        'SHIFT_CLOSE_BLOCKED',
        'Finish the LIVE workday before closing this shift',
        {
          details: { workDate, status: workday.status },
        },
      );
    }
    await this.refresh(context.tx, context.now, workDate);
    const unresolvedCount = await context.tx.alert.count({
      where: { kind: 'alert', isBlocking: true, resolvedAt: null, invalidatedAt: null },
    });
    if (unresolvedCount > 0) {
      throw new SysError('SHIFT_CLOSE_BLOCKED', 'Resolve every alert before closing this shift', {
        details: { workDate, unresolvedCount },
      });
    }
    const closure = await context.tx.shiftClosure.upsert({
      where: { workDate },
      update: {},
      create: {
        workDate,
        closedAt: BigInt(context.now),
        closedBy: context.actor.id,
        operationId: context.operationId,
      },
    });
    if (workday && this.performance) {
      const capturedAt = await businessNow(context.tx, context.now, workDate);
      await this.performance.snapshotIn(context.tx, workday.id, capturedAt);
    }
    return { workDate, closedAt: Number(closure.closedAt), unresolvedCount: 0 };
  }

  private async applyAction(
    context: OperationContext,
    alert: {
      id: string;
      code: string;
      requestIds: string[];
      engineerIds: string[];
      workDate: string | null;
    },
    input: ResolveAlertInput,
  ): Promise<void> {
    const requestId = alert.requestIds[0];
    const engineerId = input.engineerId ?? alert.engineerIds[0];
    if (input.action === 'prioritize') {
      if (!requestId || !alert.workDate)
        throw SysError.validationFailed('This alert names no request day');
      const request = await context.tx.request.findUnique({ where: { id: requestId } });
      if (request?.lifecycle !== 'submitted' || request.startedAt !== null)
        throw new SysError(
          'WORK_ALREADY_STARTED',
          'Only an unstarted request can receive priority',
        );
      const previous = await readRequestPriority(context.tx, alert.workDate);
      if (
        previous &&
        previous.requestId !== requestId &&
        input.expectedPriorityVersion !== previous.version
      )
        throw new SysError(
          'VERSION_CONFLICT',
          'Этот план уже построен с приоритетом другой заявки. Подтвердите замену приоритета.',
        );
      const value = { requestId, version: context.operationId };
      await context.tx.appState.upsert({
        where: { key: requestPriorityKey(alert.workDate) },
        create: { key: requestPriorityKey(alert.workDate), value, updatedAt: BigInt(context.now) },
        update: { value, updatedAt: BigInt(context.now) },
      });
      await context.tx.request.update({
        where: { id: requestId },
        data: {
          routingDeferredUntil: null,
          assignmentState: 'pending',
          version: { increment: 1 },
          updatedAt: BigInt(context.now),
        },
      });
      await this.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.POLICY_CHANGED,
        { businessTime: true },
      );
      return;
    }
    if (input.action === 'reschedule' || input.action === 'move_window') {
      if (!requestId) throw new SysError('VALIDATION_FAILED', 'This alert names no request');
      await lockRoutingCurrent(context.tx);
      const request = await context.tx.request.findUnique({ where: { id: requestId } });
      if (request?.lifecycle !== 'submitted') {
        throw new SysError('WORK_ALREADY_STARTED', 'Only a submitted request can be rescheduled');
      }
      if (input.action === 'move_window' && input.expectedRequestVersion !== request.version)
        throw new SysError('VERSION_CONFLICT', 'Request changed; reopen the window form', {
          details: { currentVersion: request.version },
        });
      const start =
        input.action === 'reschedule'
          ? Number(request.windowStartAt) + 86_400
          : input.windowStartAt;
      const end =
        input.action === 'reschedule' ? Number(request.windowEndAt) + 86_400 : input.windowEndAt;
      if (start === undefined || end === undefined || end <= start) {
        throw new SysError('VALIDATION_FAILED', 'Moving a window needs both ordered bounds');
      }
      assertEmergencyWindowUnchanged(request, start, end);
      requireWindowConfirmation(context.actor, {
        requestId,
        version: request.version,
        previousStartAt: Number(request.windowStartAt),
        previousEndAt: Number(request.windowEndAt),
        windowStartAt: start,
        windowEndAt: end,
      });
      const liveDay = await context.tx.liveWorkday.findFirst({ where: { status: 'running' } });
      const assignedStop = await context.tx.appliedPlanStop.findFirst({
        where: { requestId, route: { plan: { current: { isNot: null } } } },
        select: { id: true },
      });
      const liveOwnership = liveDay
        ? await context.tx.liveRequestState.findFirst({
            where: {
              requestId,
              workdayId: liveDay.id,
              OR: [{ assumedStartedAt: { not: null } }, { reservedEngineerId: { not: null } }],
            },
            select: { id: true },
          })
        : null;
      // Deferring free work outside today's horizon does not alter anyone's route.
      // Future publications will read the new window; stale in-flight results are
      // rejected by the acceptance service's window check.
      const deferFreeWork =
        liveDay !== null &&
        request.assignmentState === 'unassigned' &&
        assignedStop === null &&
        liveOwnership === null &&
        start >= zonedWallUnix(`${liveDay.workDate}T00:00:00`) + 86_400;
      await context.tx.requestConditionHistory.create({
        data: {
          requestId,
          changedAt: BigInt(context.now),
          operationId: context.operationId,
          previous: {
            windowStartAt: Number(request.windowStartAt),
            windowEndAt: Number(request.windowEndAt),
          },
          reason: input.reason ?? input.action,
        },
      });
      const changed = await context.tx.request.updateMany({
        where: { id: requestId, version: request.version },
        data: {
          windowStartAt: BigInt(start),
          windowEndAt: BigInt(end),
          assignmentState: 'pending',
          routingDeferredUntil: null,
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new SysError('VERSION_CONFLICT', 'Request changed during resolution');
      if (!deferFreeWork)
        await this.publisher.publishIfChanged(
          context.tx,
          context.now,
          PUBLICATION_TRIGGERS.REQUEST_CONDITIONS_CHANGED,
          { businessTime: true },
        );
      return;
    }
    if (input.action === 'add_engineer') {
      if (!input.engineerId || !alert.workDate)
        throw new SysError(
          'VALIDATION_FAILED',
          'Adding an engineer needs engineerId and work date',
        );
      if (!requestId) throw new SysError('VALIDATION_FAILED', 'Adding an engineer needs a request');
      const [day, request] = await Promise.all([
        context.tx.engineerDay.findUnique({
          where: {
            engineerId_workDate: { engineerId: input.engineerId, workDate: alert.workDate },
          },
          include: { engineer: { include: { account: true } } },
        }),
        context.tx.request.findUnique({ where: { id: requestId } }),
      ]);
      if (!day)
        throw SysError.notFound('Engineer day', {
          engineerId: input.engineerId,
          workDate: alert.workDate,
        });
      if (
        request?.lifecycle !== 'submitted' ||
        day.availability !== 'offline' ||
        day.engineer.archivedAt !== null ||
        (request.region !== null && day.engineer.region !== request.region) ||
        (request.requiredTransport !== null &&
          day.engineer.transportType !== request.requiredTransport) ||
        !day.engineer.skills.includes(request.requiredSkill) ||
        Number(day.shiftStartAt) > Number(request.windowStartAt) ||
        Number(day.shiftEndAt) < Number(request.windowEndAt)
      ) {
        throw new SysError('VALIDATION_FAILED', 'This engineer cannot be added to this request', {
          details: { engineerId: input.engineerId, requestId },
        });
      }
      await context.tx.engineerDay.update({
        where: { id: day.id },
        data: {
          availability: 'online',
          attendanceOptOut: false,
          attendanceGraceUntil: BigInt(context.now + (await this.thresholds(context.tx)).noShowSec),
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
      await context.tx.request.update({
        where: { id: requestId },
        data: {
          assignmentState: 'pending',
          routingDeferredUntil: null,
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
      await this.notifications.record(context.tx, context.now, {
        category: 'engineer_attention_required',
        businessEventKey: `engineer_called_in:${alert.id}:${input.engineerId}`,
        recipientEmail: day.engineer.account?.email ?? null,
        payload: { engineerId: input.engineerId, alertCode: 'called_in' },
      });
      await this.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.ENGINEER_AVAILABILITY_CHANGED,
        { businessTime: true },
      );
      return;
    }
    if (input.action === 'keep_manual') {
      if (!input.reason)
        throw new SysError('VALIDATION_FAILED', 'Keeping a degraded plan requires a reason');
      const pointer = await context.tx.appliedPlanCurrent.findUnique({
        where: { id: 'singleton' },
        include: { plan: true },
      });
      if (pointer?.plan.origin === 'manual')
        await context.tx.controlState.update({
          where: { id: 'singleton' },
          data: {
            mode: 'manual',
            frozenPlanId: pointer.plan.id,
            changedAt: BigInt(context.now),
            changedBy: context.actor.id,
            modeVersion: { increment: 1 },
          },
        });
      return;
    }
    if (input.action === 'keep_as_is') return;
    if (input.action === 'restore_auto') {
      if (!this.router.isConfigured())
        throw SysError.notConfigured('Router automatic plan restoration');
      await context.tx.controlState.update({
        where: { id: 'singleton' },
        data: {
          mode: 'auto',
          frozenPlanId: null,
          changedAt: BigInt(context.now),
          changedBy: context.actor.id,
          modeVersion: { increment: 1 },
        },
      });
      const manual = await readManualState(context.tx);
      await writeManualState(
        context.tx,
        {
          ...manual,
          version: manual.version + 1,
          reason: null,
          decisions: [],
          acknowledgedConflicts: [],
          resolution: null,
        },
        context.now,
      );
      await this.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.MANUAL_DECISIONS_CHANGED,
        { force: true, businessTime: true },
      );
      return;
    }
    if (input.action === 'skip_lunch' || input.action === 'keep_lunch') {
      if (!engineerId || !alert.workDate)
        throw new SysError('VALIDATION_FAILED', 'This alert names no engineer day');
      const day = await context.tx.engineerDay.findUnique({
        where: { engineerId_workDate: { engineerId, workDate: alert.workDate } },
      });
      if (!day) throw SysError.notFound('Engineer day', { engineerId, workDate: alert.workDate });
      await context.tx.engineerDay.update({
        where: { id: day.id },
        data:
          input.action === 'skip_lunch'
            ? {
                lunchEnabled: false,
                lunchRequired: false,
                updatedAt: BigInt(context.now),
                version: { increment: 1 },
              }
            : { lunchRequired: true, updatedAt: BigInt(context.now), version: { increment: 1 } },
      });
      await this.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.LUNCH_RESTORED,
        { businessTime: true },
      );
      return;
    }
    if (!engineerId || !alert.workDate)
      throw new SysError('VALIDATION_FAILED', 'This alert names no engineer day');
    const day = await context.tx.engineerDay.findUnique({
      where: { engineerId_workDate: { engineerId, workDate: alert.workDate } },
      include: { engineer: { include: { account: true } } },
    });
    if (!day) throw SysError.notFound('Engineer day', { engineerId, workDate: alert.workDate });
    if (input.action === 'make_passive') {
      await context.tx.engineerDay.update({
        where: { id: day.id },
        data: { attendanceOptOut: true, updatedAt: BigInt(context.now), version: { increment: 1 } },
      });
      return;
    }
    if (input.action === 'message' || input.action === 'message_remove') {
      await this.notifications.record(context.tx, context.now, {
        category: 'engineer_attention_required',
        businessEventKey: `engineer_attention:${alert.code}:${alert.id}`,
        recipientEmail: day.engineer.account?.email ?? null,
        payload: {
          engineerId,
          alertCode: alert.code,
          action: input.action,
          message: input.reason ?? null,
        },
      });
    }
    if (input.action === 'remove_shift' || input.action === 'message_remove') {
      await context.tx.engineerDay.update({
        where: { id: day.id },
        data: {
          availability: 'offline',
          attendanceOptOut: true,
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
      await this.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.ENGINEER_AVAILABILITY_CHANGED,
        { businessTime: true },
      );
      return;
    }
    if (input.action === 'extend') {
      if (!input.minutes)
        throw new SysError('VALIDATION_FAILED', 'Extending needs a positive minutes value');
      if (alert.code === 'shift_no_show' && input.minutes !== 15) {
        throw new SysError('VALIDATION_FAILED', 'A no-show can only be extended by 15 minutes');
      }
      await context.tx.engineerDay.update({
        where: { id: day.id },
        data: {
          expectedOnlineAt: BigInt(context.now + input.minutes * 60),
          attendanceGraceUntil: BigInt(context.now + input.minutes * 60),
          updatedAt: BigInt(context.now),
          version: { increment: 1 },
        },
      });
    }
  }

  /** Derives open alerts only from facts/schedules that actually exist. */
  private async refresh(
    tx: Tx,
    now: number,
    scopeDate?: string,
    businessTime = false,
  ): Promise<void> {
    await lockAlertQueue(tx);
    if (!businessTime) now = await businessNow(tx, now, scopeDate);
    const thresholds = await this.thresholds(tx);
    const active = new Set<string>();
    const windowChanges = await tx.alert.findMany({
      where: {
        resolutionAction: { in: ['move_window', 'prioritize'] },
        resolvedAt: null,
        invalidatedAt: null,
      },
      select: { id: true, requestIds: true, createdAt: true },
    });
    const awaitingWindow = new Set<string>();
    for (const alert of windowChanges) {
      const request = alert.requestIds[0]
        ? await tx.request.findUnique({ where: { id: alert.requestIds[0] } })
        : null;
      if (request?.lifecycle === 'submitted' && request.assignmentState !== 'assigned') {
        awaitingWindow.add(alert.id);
      } else {
        await tx.alert.update({
          where: { id: alert.id },
          data: {
            resolvedAt: BigInt(now),
            resolutionDelaySec: resolutionDelay(now - Number(alert.createdAt)),
          },
        });
        await finalizeAlertAttribution(tx, alert.id, now);
      }
    }
    // Router and system episodes both become obsolete once the request is no
    // longer free work. Preserve the audit row, but remove it from the open queue.
    const unassignedAlerts = await tx.alert.findMany({
      where: { code: 'unassigned', resolvedAt: null, invalidatedAt: null },
      select: { id: true, requestIds: true },
    });
    for (const alert of unassignedAlerts) {
      if (awaitingWindow.has(alert.id)) continue;
      if (alert.requestIds.length === 0) continue;
      const remaining = await tx.request.count({
        where: {
          id: { in: alert.requestIds },
          lifecycle: 'submitted',
          assignmentState: 'unassigned',
        },
      });
      if (remaining === 0)
        await tx.alert.update({
          where: { id: alert.id },
          data: {
            resolvedAt: BigInt(now),
            invalidatedAt: BigInt(now),
            resolutionAction: 'superseded',
          },
        });
    }
    const liveRunning = await tx.liveWorkday.findFirst({
      where: {
        status: { in: ['running', 'finished'] },
        ...(scopeDate ? { workDate: scopeDate } : {}),
      },
      orderBy: { startedAtWallSec: 'desc' },
      select: { id: true },
    });
    const routerAlerts = await tx.alert.findMany({
      where: { dedupKey: { startsWith: 'router:' }, invalidatedAt: null },
      select: { id: true, code: true, reasons: true, engineerIds: true, workDate: true },
    });
    for (const alert of routerAlerts) {
      const lunchDay =
        alert.code === 'lunch_conflict' && alert.engineerIds[0] && alert.workDate
          ? await tx.engineerDay.findUnique({
              where: {
                engineerId_workDate: { engineerId: alert.engineerIds[0], workDate: alert.workDate },
              },
              include: { engineer: true },
            })
          : null;
      if (
        alert.code === 'lunch_conflict' &&
        ((liveRunning && lunchCoverageWitness(alert.reasons) === null) ||
          (lunchDay &&
            (lunchDay.engineer.archivedAt !== null ||
              lunchDay.availability !== 'online' ||
              lunchDay.lunchTaken ||
              !lunchDay.lunchEnabled ||
              now >= Number(lunchDay.lunchWindowEndAt ?? lunchDay.shiftEndAt))))
      ) {
        await tx.alert.update({
          where: { id: alert.id },
          data: {
            invalidatedAt: BigInt(now),
            resolvedAt: BigInt(now),
            resolutionAction: 'superseded',
          },
        });
        continue;
      }
      const lunchStartAt = lunchCoverageWitness(alert.reasons)?.lunch_start_at ?? null;
      if (lunchStartAt !== null && now >= lunchStartAt) {
        await tx.alert.update({
          where: { id: alert.id },
          data: {
            invalidatedAt: BigInt(now),
            resolvedAt: BigInt(now),
            resolutionAction: 'superseded',
          },
        });
      }
    }
    const liveWindowAlerts = await tx.alert.findMany({
      where: { code: 'LIVE_WINDOW_COMPLETION_RISK', resolvedAt: null, invalidatedAt: null },
      select: { id: true, requestIds: true, engineerIds: true },
    });
    const accepted =
      liveWindowAlerts.length > 0
        ? await tx.appliedPlanCurrent.findUnique({
            where: { id: 'singleton' },
            select: { plan: { select: { revision: true } } },
          })
        : null;
    for (const alert of liveWindowAlerts) {
      const requestId = alert.requestIds[0];
      const request = requestId ? await tx.request.findUnique({ where: { id: requestId } }) : null;
      const state = requestId
        ? await tx.liveRequestState.findFirst({
            where: { requestId, workday: { status: 'running' } },
          })
        : null;
      // Releasing an infeasible ETA clears reportedEtaAt intentionally. The
      // incident belongs to the pending reassignment until the window expires.
      const activeRisk =
        request !== null &&
        request.lifecycle === 'submitted' &&
        now <= Number(request.windowEndAt) &&
        state !== null &&
        state.replanPendingEngineerId !== null &&
        (accepted === null || accepted.plan.revision === state.replanPendingPlanRevision) &&
        alert.engineerIds.includes(state.replanPendingEngineerId);
      if (!activeRisk) {
        await tx.alert.update({
          where: { id: alert.id },
          data: {
            invalidatedAt: BigInt(now),
            resolvedAt: BigInt(now),
            resolutionAction: 'superseded',
          },
        });
      }
    }
    const days = await tx.engineerDay.findMany({
      where: scopeDate
        ? { workDate: scopeDate, engineer: { archivedAt: null } }
        : { engineer: { archivedAt: null } },
      include: { engineer: { select: { accountId: true, archivedAt: true } } },
    });
    for (const day of days) {
      if (day.attendanceOptOut) continue;
      if (
        now >= Number(day.shiftStartAt) + thresholds.noShowSec &&
        now <= Number(day.shiftEndAt) &&
        (day.attendanceGraceUntil === null || now >= Number(day.attendanceGraceUntil)) &&
        (day.lastAttendanceAt === null || day.lastAttendanceAt < day.shiftStartAt)
      ) {
        const key = `system:shift_no_show:${day.id}`;
        active.add(key);
        await this.ensure(tx, now, {
          key,
          code: 'shift_no_show',
          severity: 'error',
          engineerIds: [day.engineerId],
          requestIds: [],
          workDate: day.workDate,
          reasons: {
            shiftStartAt: Number(day.shiftStartAt),
            thresholdAt: Number(day.shiftStartAt) + thresholds.noShowSec,
          },
        });
      }
    }
    const requests = await tx.request.findMany({
      where: { lifecycle: 'submitted', assignmentState: 'unassigned' },
    });
    for (const request of requests) {
      const date = workDateForMoment(Number(request.windowStartAt), days) ?? scopeDate ?? null;
      if (scopeDate && date !== scopeDate) continue;
      const key = `system:unassigned:${date}:${request.id}`;
      active.add(key);
      await this.ensure(tx, now, {
        key,
        code: 'unassigned',
        severity: 'error',
        engineerIds: [],
        requestIds: [request.id],
        workDate: date,
        reasons: {
          assignment: 'unassigned',
          ordinaryReplanningDisabled:
            request.routingDeferredUntil !== null && Number(request.routingDeferredUntil) > now,
        },
      });
    }
    const pointer = await tx.appliedPlanCurrent.findUnique({
      where: { id: 'singleton' },
      include: { plan: { include: { routes: { include: { stops: true } }, assignments: true } } },
    });
    if (pointer?.plan) {
      const completedFacts = await tx.requestFact.findMany({
        where: { kind: 'finished', engineerId: { not: null } },
        select: { engineerId: true, occurredAt: true },
      });
      const requestsById = new Map(
        (
          await tx.request.findMany({
            where: { id: { in: pointer.plan.assignments.map((x) => x.requestId) } },
          })
        ).map((x) => [x.id, x]),
      );
      const timing = this.timing?.current() ?? DEFAULT_EXECUTION_TIMING_POLICY;
      const liveStates = await tx.liveRequestState.findMany({
        where: { workday: { status: 'running' } },
        include: { request: true, workday: true },
      });
      const liveStateByRequest = new Map(liveStates.map((state) => [state.requestId, state]));
      for (const state of liveStates) {
        const request = state.request;
        if (
          !['submitted', 'in_progress'].includes(request.lifecycle) ||
          state.assumedCompletedAt !== null
        )
          continue;
        const route = pointer.plan.routes.find((candidate) =>
          candidate.stops.some((stop) => stop.requestId === request.id),
        );
        const stop = route?.stops
          .filter((candidate) => candidate.requestId === request.id)
          .sort((a, b) => a.sequence - b.sequence)[0];
        const engineerId = route?.engineerId ?? state.reservedEngineerId;
        if (!engineerId) continue;
        const original = await tx.appState.findUnique({
          where: { key: `live.arrival-baseline.${state.workdayId}.${request.id}` },
        });
        const parsed = z.object({ plannedStartAt: z.number() }).safeParse(original?.value);
        const plannedStartAt = parsed.success
          ? parsed.data.plannedStartAt
          : Number(stop?.startAt ?? request.startedAt ?? request.windowStartAt);
        const etaRisk =
          request.lifecycle === 'submitted' &&
          now <= Number(request.windowEndAt) &&
          state.reportedEtaAt !== null &&
          Number(state.reportedEtaAt) > plannedStartAt + timing.taskOverrunToleranceSec;
        const windowRisk =
          request.lifecycle === 'submitted' &&
          now <= Number(request.windowEndAt) &&
          state.reportedEtaAt !== null &&
          Number(state.reportedEtaAt) + request.serviceDurationSec >
            Number(request.windowEndAt) + timing.taskOverrunToleranceSec;
        const workRisk =
          request.lifecycle === 'in_progress' &&
          request.startedAt !== null &&
          now >
            Number(request.startedAt) + request.serviceDurationSec + timing.taskOverrunToleranceSec;
        if (!etaRisk && !windowRisk && !workRisk) continue;
        const date = state.workday.workDate;
        if (scopeDate && date !== scopeDate) continue;
        const key = `system:time_risk:${date}:${request.id}:${engineerId}`;
        active.add(key);
        await this.ensure(tx, now, {
          key,
          code: 'time_risk',
          severity: 'warning',
          engineerIds: [engineerId],
          requestIds: [request.id],
          workDate: date,
          reasons: {
            text: workRisk
              ? 'Работа длится дольше нормативного времени с учётом допуска.'
              : windowRisk
                ? 'Прогноз завершения заявки выходит за окно клиента с учётом допуска.'
                : 'Инженер сообщил прибытие позже планового времени с учётом допуска.',
            plannedStartAt,
            reportedEtaAt: state.reportedEtaAt === null ? null : Number(state.reportedEtaAt),
            windowEndAt: Number(request.windowEndAt),
            startedAt: request.startedAt === null ? null : Number(request.startedAt),
            thresholdSec: timing.taskOverrunToleranceSec,
            etaRisk,
            windowRisk,
            workRisk,
          },
        });
      }
      for (const route of pointer.plan.routes) {
        const day = days.find(
          (candidate) =>
            candidate.engineerId === route.engineerId &&
            now >= Number(candidate.shiftStartAt) &&
            now <= Number(candidate.shiftEndAt),
        );
        const working = route.stops.some(
          (stop) => stop.requestId && requestsById.get(stop.requestId)?.lifecycle === 'in_progress',
        );
        const lateStop =
          day &&
          route.stops
            .filter(
              (stop) =>
                stop.kind === 'job' &&
                stop.requestId &&
                requestsById.get(stop.requestId)?.lifecycle === 'submitted',
            )
            .sort((a, b) => a.sequence - b.sequence)[0];
        if (
          pointer.plan.origin === 'auto' &&
          day &&
          completedFacts.some(
            (fact) =>
              fact.engineerId === route.engineerId &&
              Number(fact.occurredAt) >= Number(day.shiftStartAt) &&
              Number(fact.occurredAt) <= Number(day.shiftEndAt),
          ) &&
          day.availability === 'online' &&
          !working &&
          !day.attendanceOptOut &&
          (day.attendanceGraceUntil === null || now >= Number(day.attendanceGraceUntil)) &&
          lateStop &&
          (lateStop.requestId
            ? (liveStateByRequest.get(lateStop.requestId)?.reportedEtaAt ?? null) === null
            : false) &&
          now >
            Number(lateStop.startAt) + (thresholds.overdueSec || timing.taskOverrunToleranceSec) &&
          Number(day.lastAttendanceAt ?? 0n) < Number(lateStop.arrivalAt)
        ) {
          const key = `system:engineer_overdue:edge:${day.id}:${lateStop.requestId}`;
          active.add(key);
          await this.ensure(tx, now, {
            key,
            code: 'engineer_overdue',
            severity: 'warning',
            engineerIds: [route.engineerId],
            requestIds: lateStop.requestId ? [lateStop.requestId] : [],
            workDate: day.workDate,
            reasons: {
              state: 'on_route_edge',
              expectedAt: Number(lateStop.arrivalAt),
              lastAttendanceAt: day.lastAttendanceAt === null ? null : Number(day.lastAttendanceAt),
            },
          });
        }
      }
      for (const day of days) {
        if (
          !day.lunchEnabled ||
          now >= Number(day.lunchWindowEndAt ?? day.shiftEndAt) ||
          !day.lunchRequired ||
          day.lunchTaken ||
          day.availability !== 'online' ||
          day.workDate !== workDateForMoment(Number(pointer.plan.planAsOf), days)
        )
          continue;
        const route = pointer.plan.routes.find((x) => x.engineerId === day.engineerId);
        if (!liveRunning && route?.lunchStatus !== 'scheduled') {
          const key = `system:lunch_conflict:${day.id}`;
          active.add(key);
          await this.ensure(tx, now, {
            key,
            code: 'lunch_conflict',
            severity: 'warning',
            engineerIds: [day.engineerId],
            requestIds: [],
            workDate: day.workDate,
            reasons: { lunchStatus: route?.lunchStatus ?? 'not_scheduled' },
          });
        }
      }
      if (pointer.plan.origin === 'manual' && !liveRunning) {
        const row = await tx.appState.findUnique({ where: { key: 'alerts.manual-evaluation' } });
        const evidence = manualEvidenceSchema.safeParse(row?.value);
        const publication = await tx.routingCurrent.findUnique({
          where: { id: 'singleton' },
          include: { snapshot: true },
        });
        const evaluation =
          evidence.success &&
          evidence.data.planId === pointer.plan.id &&
          evidence.data.inputHash === publication?.snapshot.inputHash
            ? evidence.data.evaluation
            : null;
        if (!evaluation) {
          const code = 'plan_review_required';
          const key = `system:${code}:${pointer.plan.id}`;
          active.add(key);
          await this.ensure(tx, now, {
            key,
            code,
            severity: 'warning',
            engineerIds: [],
            requestIds: [],
            workDate: scopeDate ?? null,
            reasons: {
              text: 'Оценка ручного плана временно недоступна. Проверьте решение вручную или восстановите автоматический вариант.',
              ...(evaluation ?? {}),
            },
          });
        }
      }
    }
    const openSystem = await tx.alert.findMany({
      where: {
        dedupKey: { startsWith: 'system:' },
        ...(scopeDate ? { workDate: scopeDate } : {}),
        invalidatedAt: null,
      },
      select: {
        id: true,
        dedupKey: true,
        resolvedAt: true,
        resolutionAction: true,
        createdAt: true,
        reasons: true,
      },
    });
    for (const alert of openSystem) {
      if (awaitingWindow.has(alert.id)) continue;
      const dedupKey = alert.dedupKey;
      if (
        dedupKey?.startsWith('system:plan_degraded:policy:') &&
        !(alert.resolutionAction === 'restore_auto' && pointer?.plan.origin === 'auto')
      ) {
        const reasons = z.object({ expiresAt: z.number().nullable() }).safeParse(alert.reasons);
        if (reasons.success && (reasons.data.expiresAt === null || now <= reasons.data.expiresAt))
          continue;
      }
      if (
        alert.resolutionAction === 'restore_auto' &&
        alert.resolvedAt === null &&
        pointer?.plan.origin !== 'auto'
      )
        continue;
      if (dedupKey && ![...active].some((key) => dedupKey.startsWith(key))) {
        await tx.alert.update({
          where: { id: alert.id },
          data: {
            invalidatedAt: BigInt(now),
            ...(alert.resolvedAt === null
              ? {
                  resolvedAt: BigInt(now),
                  resolutionAction:
                    alert.resolutionAction === 'restore_auto' ? 'restore_auto' : 'superseded',
                  resolutionDelaySec:
                    alert.resolutionAction === 'restore_auto'
                      ? resolutionDelay(now - Number(alert.createdAt))
                      : null,
                }
              : {}),
          },
        });
      }
    }
  }

  private async ensure(
    tx: Tx,
    now: number,
    input: {
      key: string;
      code: string;
      severity: 'info' | 'warning' | 'error';
      engineerIds: string[];
      requestIds: string[];
      workDate: string | null;
      reasons: object;
    },
  ): Promise<void> {
    const matchingOpen = await tx.alert.findFirst({
      where: {
        code: input.code,
        workDate: input.workDate,
        resolvedAt: null,
        invalidatedAt: null,
        OR: [
          { dedupKey: { startsWith: input.key } },
          // Reuse a Router condition, never an unrelated system episode whose
          // different reconciliation key would immediately expire it.
          { dedupKey: { startsWith: 'router:' } },
        ],
        engineerIds: { equals: input.engineerIds },
        requestIds: { equals: input.requestIds },
      },
    });
    if (matchingOpen) {
      await tx.alert.update({
        where: { id: matchingOpen.id },
        data: { reasons: input.reasons, severity: input.severity },
      });
      return;
    }
    const latest = await tx.alert.findFirst({
      where: { dedupKey: { startsWith: input.key } },
      orderBy: { createdAt: 'desc' },
    });
    // A no-show is one attendance episode for one engineer-day. Resolution changes
    // the action state but must not make the same absence produce duplicate episodes.
    if (latest?.code === 'shift_no_show') {
      if (latest.resolutionAction === 'extend') {
        await tx.alert.update({
          where: { id: latest.id },
          data: {
            resolvedAt: null,
            invalidatedAt: null,
            resolutionAction: null,
            resolutionReason: null,
            resolutionDelaySec: null,
            reasons: input.reasons,
          },
        });
      }
      return;
    }
    if (latest?.resolvedAt != null && latest.invalidatedAt === null) {
      if (latest.resolutionAction === 'move_window' || latest.resolutionAction === 'prioritize') {
        await tx.alert.update({
          where: { id: latest.id },
          data: {
            resolvedAt: null,
            resolutionDelaySec: null,
            reasons: input.reasons,
          },
        });
        return;
      }
      if (!['shift_no_show', 'engineer_overdue'].includes(input.code)) return;
      if (
        latest.resolutionAction === 'message' &&
        now - Number(latest.resolvedAt) < (await this.thresholds(tx)).repeatAfterSec
      )
        return;
    }
    const dedupKey = latest ? `${input.key}:episode:${now}` : input.key;
    await tx.alert.create({
      data: {
        dedupKey,
        code: input.code,
        severity: input.severity,
        engineerIds: input.engineerIds,
        requestIds: input.requestIds,
        reasons: input.reasons,
        workDate: input.workDate,
        isBlocking: true,
        createdAt: BigInt(now),
      },
    });
  }

  private async workDateForEngineer(
    tx: Tx,
    engineerId: string | undefined,
  ): Promise<string | null> {
    if (!engineerId) return null;
    const day = await tx.engineerDay.findFirst({
      where: { engineerId },
      orderBy: { workDate: 'desc' },
      select: { workDate: true },
    });
    return day?.workDate ?? null;
  }
}

/** Stores the first authenticated alert intervention and later closes pending windows. */
async function recordAlertAttribution(
  tx: Tx,
  now: number,
  alert: { id: string; code: string; workDate: string | null; createdAt: bigint },
  actor: Actor,
  input: ResolveAlertInput,
  resolved: boolean,
): Promise<void> {
  const key = `${PERFORMANCE_ALERT_PREFIX}${alert.id}`;
  const current = await tx.appState.findUnique({ where: { key } });
  if (!current) {
    await tx.appState.create({
      data: {
        key,
        value: {
          version: 1,
          alertId: alert.id,
          code: alert.code,
          workDate: alert.workDate,
          createdAt: Number(alert.createdAt),
          firstAction: {
            action: input.action,
            at: now,
            actorKind: actor.kind,
            actorSource: actor.source,
          },
          outcome: resolved ? 'resolved' : 'pending',
          resolvedAt: resolved ? now : null,
          resolutionReason: input.reason ?? null,
        },
        updatedAt: BigInt(now),
      },
    });
    return;
  }
  const existing = current.value;
  if (
    resolved &&
    existing &&
    typeof existing === 'object' &&
    !Array.isArray(existing) &&
    'outcome' in existing &&
    existing.outcome === 'pending'
  ) {
    await tx.appState.update({
      where: { key },
      data: {
        value: { ...(existing as Record<string, unknown>), outcome: 'resolved', resolvedAt: now },
        updatedAt: BigInt(now),
      },
    });
  }
}

/** Marks a previously recorded window action resolved only after the plan state confirms it. */
async function finalizeAlertAttribution(tx: Tx, alertId: string, now: number): Promise<void> {
  const key = `${PERFORMANCE_ALERT_PREFIX}${alertId}`;
  const current = await tx.appState.findUnique({ where: { key } });
  const value = current?.value;
  if (
    !current ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('outcome' in value) ||
    value.outcome !== 'pending'
  )
    return;
  await tx.appState.update({
    where: { key },
    data: {
      value: { ...(value as Record<string, unknown>), outcome: 'resolved', resolvedAt: now },
      updatedAt: BigInt(now),
    },
  });
}

function canonicalRouterCode(code: string): string {
  const normalized = code.toLowerCase();
  if (normalized === 'live_window_completion_risk') return 'time_risk';
  if (normalized === 'lunch_coverage_gain') return 'lunch_conflict';
  if (normalized === 'routing_fail') return 'unassigned';
  if (
    ['required_lunch_unplaced', 'lunch_not_placed', 'lunch_skipped_for_work'].includes(normalized)
  )
    return 'lunch_conflict';
  return normalized;
}

function workDateForMoment(
  moment: number,
  _days: Array<{ workDate: string; shiftStartAt: bigint; shiftEndAt: bigint }>,
): string | null {
  return new Date((moment + 3 * 3600) * 1000).toISOString().slice(0, 10);
}
