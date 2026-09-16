import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import { NotificationsService } from '../../notifications';
import type { Tx } from '../../persistence';
import { lockControlState, lockRoutingCurrent, PrismaService, UnitOfWork } from '../../persistence';
import { AppliedPlanService } from './applied-plan.service';
import { type RouterResult, routerResultSchema } from './result.types';

export interface AcceptanceOutcome {
  readonly accepted: boolean;
  /** Why it was not accepted, as an error code from the catalogue. */
  readonly reason?: string;
  readonly detail?: string;
  readonly resultId?: string | null;
  readonly planRevision?: number;
}

/**
 * `ROUTER-gateway`: decides whether a finished result becomes the working plan.
 *
 * Five independent checks, all required, none substituting for another
 * (context/33 section 7):
 *
 *   1. the mode allows it -- in MANUAL the bus is disconnected;
 *   2. `input_hash` matches the snapshot that is published *now*;
 *   3. `router_context_version` matches the version in force *now*;
 *   4. `main.is_usable` -- a finished answer is not automatically an applicable one;
 *   5. no conflict with explicit facts -- started, finished or cancelled work is not
 *      redistributed, and a used lunch is not planned again.
 *
 * When a result conflicts with the facts, sys does **not** repair it with an optimiser of
 * its own. It declines to apply it and publishes a current projection instead; choosing
 * assignments is Router's job and stays Router's job (context/33 section 7).
 */
@Injectable()
export class ResultAcceptanceService {
  private readonly logger = new Logger(ResultAcceptanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly plans: AppliedPlanService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Validates and, if everything holds, applies one result.
   *
   * `allowRepeatOfKnownResult` is the single exception the concept carves out: returning
   * to AUTO is an explicit transition that may apply a still-suitable result the system
   * has seen before. Ordinary re-reads never do (context/33 section 7).
   */
  async accept(
    raw: unknown,
    activeContextVersion: string | null,
    options: { allowRepeatOfKnownResult?: boolean } = {},
  ): Promise<AcceptanceOutcome> {
    const parsed = routerResultSchema.safeParse(raw);
    if (!parsed.success) {
      // A malformed package is a visible error, never a partly applied plan.
      throw new SysError('VALIDATION_FAILED', 'The Router result does not match the contract', {
        details: { issues: parsed.error.issues.slice(0, 10) },
      });
    }
    const result = parsed.data;

    if (result.status === 'pending') {
      return { accepted: false, reason: 'PENDING', detail: 'Router has no result yet' };
    }
    if (result.status === 'error') {
      // A visible error, not an endless spinner and not a mass refusal to customers
      // (context/33 section 10.5).
      await this.recordPackage(result, false, 'ROUTER_ERROR');
      return {
        accepted: false,
        reason: 'ROUTER_ERROR',
        detail: result.errors[0]?.message ?? 'Router reported an error',
      };
    }

    return this.uow.run(async (tx) => {
      // Both singletons are locked before anything is decided, so a result already in
      // flight cannot land after the dispatcher takes manual control.
      await lockControlState(tx);
      await lockRoutingCurrent(tx);

      const control = await tx.controlState.findUniqueOrThrow({ where: { id: 'singleton' } });
      if (control.mode === 'manual') {
        return this.reject(tx, result, 'MODE_MANUAL', 'Emergency manual mode is on');
      }

      const current = await tx.routingCurrent.findUnique({
        where: { id: 'singleton' },
        include: { snapshot: true },
      });
      if (!current) {
        return this.reject(tx, result, 'SNAPSHOT_STALE', 'No task has been published yet');
      }
      if (result.input_hash !== current.snapshot.inputHash) {
        // Not a failure: the answer belongs to an earlier task and a newer one is on its
        // way. The interface keeps showing the last applied plan.
        return this.reject(
          tx,
          result,
          'SNAPSHOT_STALE',
          'The result belongs to a snapshot that is no longer published',
        );
      }
      if (result.router_context_version !== activeContextVersion) {
        return this.reject(
          tx,
          result,
          'RESULT_NOT_APPLICABLE',
          'The result used a map or technical context that is no longer active',
        );
      }
      if (!result.main?.is_usable) {
        // A finished answer that must not become the working plan. It does not prove that
        // the visits are impossible, and it does not cancel anything.
        return this.reject(
          tx,
          result,
          'RESULT_NOT_APPLICABLE',
          'The main plan is not usable and cannot become the working plan',
        );
      }

      const alreadyApplied = await tx.routerResult.findUnique({
        where: { resultId: result.result_id ?? '' },
      });
      if (alreadyApplied?.accepted && !options.allowRepeatOfKnownResult) {
        // Re-reading the same result does not apply it again, does not return completed
        // work to the pool and does not repeat a letter (context/33 section 7).
        return { accepted: false, reason: 'ALREADY_APPLIED', resultId: result.result_id };
      }

      const conflict = await this.conflictWithFacts(tx, result);
      if (conflict) {
        return this.reject(tx, result, 'RESULT_NOT_APPLICABLE', conflict);
      }

      const stored = await this.storePackage(tx, result, true, null);
      const plan = await this.plans.applyAutomatic(tx, this.clock.nowSeconds(), result, stored.id);
      await this.recordAssignmentNotifications(tx, result);

      this.logger.log(
        `Applied result ${result.result_id} as plan revision ${plan.revision}: ` +
          `${result.main.summary.assigned_count}/${result.main.summary.requests_total} assigned`,
      );

      return { accepted: true, resultId: result.result_id, planRevision: plan.revision };
    });
  }

  /**
   * Checks the proposed future against what has actually happened.
   *
   * A matching hash does not prove that nothing was executed since: live state and the
   * published snapshot are deliberately separate (context/32 section 3). So the plan is
   * compared with the facts before it is allowed to become the working plan.
   */
  private async conflictWithFacts(tx: Tx, result: RouterResult): Promise<string | null> {
    const assignedIds = (result.main?.assignments ?? [])
      .filter((item) => item.status === 'assigned')
      .map((item) => item.request_id);

    if (assignedIds.length > 0) {
      const untouchable = await tx.request.findMany({
        where: {
          id: { in: assignedIds },
          OR: [
            { startedAt: { not: null } },
            { lifecycle: { in: ['in_progress', 'completed', 'cancelled'] } },
          ],
        },
        select: { id: true, lifecycle: true },
      });
      if (untouchable.length > 0) {
        return (
          'The plan distributes work that has already started, finished or been cancelled: ' +
          untouchable.map((item) => `${item.id} (${item.lifecycle})`).join(', ')
        );
      }
    }

    // A second lunch for a day whose lunch is already used.
    const lunchEngineers = (result.main?.routes ?? [])
      .filter((route) => route.lunch.status === 'scheduled')
      .map((route) => route.engineer_id);
    if (lunchEngineers.length > 0) {
      const used = await tx.engineerDay.findMany({
        where: { engineerId: { in: lunchEngineers }, lunchTaken: true },
        select: { engineerId: true },
      });
      if (used.length > 0) {
        return `The plan schedules a second lunch for ${used.map((day) => day.engineerId).join(', ')}`;
      }
    }

    return null;
  }

  private async reject(
    tx: Tx,
    result: RouterResult,
    reason: string,
    detail: string,
  ): Promise<AcceptanceOutcome> {
    await this.storePackage(tx, result, false, reason);
    return { accepted: false, reason, detail, resultId: result.result_id };
  }

  /** Keeps the package even when it was refused, so the refusal can be explained later. */
  private async storePackage(
    tx: Tx,
    result: RouterResult,
    accepted: boolean,
    rejectionCode: string | null,
  ) {
    const resultId = result.result_id ?? `unidentified-${this.clock.nowSeconds()}`;
    return tx.routerResult.upsert({
      where: { resultId },
      update: { accepted, rejectionCode, receivedAt: BigInt(this.clock.nowSeconds()) },
      create: {
        resultId,
        inputHash: result.input_hash ?? '',
        routerContextVersion: result.router_context_version ?? '',
        status: result.status,
        planningAsOf: result.planning_as_of === null ? null : BigInt(result.planning_as_of),
        computedAt: result.computed_at === null ? null : BigInt(result.computed_at),
        receivedAt: BigInt(this.clock.nowSeconds()),
        accepted,
        rejectionCode,
        payload: result as object,
      },
    });
  }

  private async recordPackage(result: RouterResult, accepted: boolean, rejectionCode: string) {
    await this.uow.run(async (tx) => {
      await this.storePackage(tx, result, accepted, rejectionCode);
    });
  }

  /**
   * One letter per business transition.
   *
   * The key is the request and the engineer, so a new result that repeats the same
   * assignment is not a new reason to write to the customer (context/36 section 10).
   */
  private async recordAssignmentNotifications(tx: Tx, result: RouterResult): Promise<void> {
    const now = this.clock.nowSeconds();
    for (const item of result.main?.assignments ?? []) {
      if (item.status !== 'assigned' || !item.engineer_id) {
        continue;
      }
      const request = await tx.request.findUnique({ where: { id: item.request_id } });
      if (!request) {
        continue;
      }
      await this.notifications.record(tx, now, {
        category: 'engineer_assigned',
        businessEventKey: `engineer_assigned:${item.request_id}:${item.engineer_id}`,
        recipientAccountId: request.clientAccountId,
        payload: { requestId: item.request_id, engineerId: item.engineer_id },
      });
    }
  }

  /** The last package received, applied or not, for the dispatcher's diagnostics. */
  async lastPackage() {
    return this.prisma.routerResult.findFirst({ orderBy: { receivedAt: 'desc' } });
  }
}
