import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { PrismaService } from '../../persistence';
import type { RouterResult } from './result.types';
import type { ResultAcceptanceService } from './result-acceptance.service';
import type { RouterClient } from './router-client.port';

type ResultAcceptor = Pick<ResultAcceptanceService, 'accept'>;

/**
 * Polls Router in the background and hands each completed package to sys acceptance.
 *
 * Polls are single-flight. A package is marked handled only after acceptance resolves, so a
 * transient HTTP, database, or acceptance failure remains retryable on the next interval.
 */
export class RouterResultCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RouterResultCoordinator.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private handledIdentity: string | null = null;

  constructor(
    private readonly client: RouterClient,
    private readonly acceptance: ResultAcceptor,
    private readonly pollIntervalMs: number,
    private readonly prisma?: PrismaService,
  ) {}

  /** Starts polling only when Router has an actual configured transport. */
  onModuleInit(): void {
    if (!this.client.isConfigured()) {
      return;
    }
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    this.timer.unref();
  }

  /** Stops the background timer during graceful application shutdown. */
  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executes at most one poll concurrently.
   *
   * Exposed for deterministic smoke and unit checks; production calls it from the timer.
   */
  pollOnce(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const current = this.pollAndApply().finally(() => {
      if (this.inFlight === current) {
        this.inFlight = null;
      }
    });
    this.inFlight = current;
    return current;
  }

  private async pollAndApply(): Promise<void> {
    try {
      const result = await this.client.getResult();
      if (result.status === 'pending') {
        return;
      }

      const identity = this.resultIdentity(result);
      const restoreManualPlan = await this.hasPendingManualRestore();
      if (identity === this.handledIdentity && !restoreManualPlan) {
        return;
      }

      const activeContextVersion = await this.client.getActiveContextVersion();
      const outcome = await this.acceptance.accept(result, activeContextVersion, {
        // Returning to AUTO is the one explicit exception that may apply a retained
        // suitable result over a manual plan. Routine polls retain their idempotence.
        allowRepeatOfKnownResult: restoreManualPlan,
      });
      // MANUAL mode is temporary: once AUTO is restored, the same still-current package
      // is intentionally eligible for acceptance without waiting for Router to recompute it.
      if (outcome.reason !== 'MODE_MANUAL') {
        this.handledIdentity = identity;
      }
      this.logger.log(
        outcome.accepted
          ? `Accepted Router result ${result.result_id ?? identity}`
          : `Handled Router result ${result.result_id ?? identity}: ${outcome.reason ?? 'rejected'}`,
      );
    } catch (error) {
      this.logger.warn(
        `Router polling failed; will retry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async hasPendingManualRestore(): Promise<boolean> {
    if (!this.prisma) return false;
    const current = await this.prisma.appliedPlanCurrent.findUnique({
      where: { id: 'singleton' },
      include: { plan: { select: { origin: true } } },
    });
    const control = await this.prisma.controlState.findUnique({ where: { id: 'singleton' } });
    return control?.mode === 'auto' && current?.plan.origin === 'manual';
  }

  private resultIdentity(result: RouterResult): string {
    if (result.result_id) {
      return result.result_id;
    }
    return JSON.stringify([
      result.status,
      result.input_publication_id,
      result.input_hash,
      result.computed_at,
      result.errors,
    ]);
  }
}
