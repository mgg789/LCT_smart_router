import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { Clock } from '../../common/time';
import { UnitOfWork } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { ExecutionTimingPolicy } from './execution-timing-policy';

/**
 * Detects the single time-driven routing event: unfinished work crossing its configured
 * overrun tolerance. It never creates a finish fact and never completes a request.
 */
@Injectable()
export class ExecutionOverrunCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionOverrunCoordinator.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly publisher: SnapshotPublisher,
    private readonly timing: ExecutionTimingPolicy,
  ) {}

  /** Starts threshold checks outside tests; test cases call `runOnce` explicitly. */
  onModuleInit(): void {
    if (this.config.isTest) {
      return;
    }
    const intervalMs = Math.max(5_000, this.config.get('ROUTER_POLL_INTERVAL_MS'));
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
  }

  /** Stops the background check on graceful shutdown. */
  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Marks and publishes every newly overdue in-progress task atomically. */
  runOnce(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const current = this.detect().finally(() => {
      if (this.inFlight === current) {
        this.inFlight = null;
      }
    });
    this.inFlight = current;
    return current;
  }

  private async detect(): Promise<void> {
    try {
      const policy = await this.timing.read();
      const now = this.clock.nowSeconds();
      const expectedBefore = BigInt(now - policy.taskOverrunToleranceSec);
      await this.uow.run(async (tx) => {
        const changed = await tx.request.updateMany({
          where: {
            lifecycle: 'in_progress',
            expectedCompletionAt: { lt: expectedBefore },
            overrunDetectedAt: null,
            // LIVE uses the persistent business clock in LiveService.  Wall-clock
            // polling would otherwise immediately overrun an accelerated demo.
            liveStates: { none: { workday: { status: 'running' } } },
          },
          data: {
            overrunDetectedAt: BigInt(now),
            updatedAt: BigInt(now),
            version: { increment: 1 },
          },
        });
        if (changed.count === 0) {
          return;
        }
        await this.publisher.publishIfChanged(
          tx,
          now,
          PUBLICATION_TRIGGERS.REQUEST_EXECUTION_OVERRUN,
        );
        this.logger.warn(`Withdrew ${changed.count} overdue engineer(s) from free capacity`);
      });
    } catch (error) {
      this.logger.error(
        `Execution overrun check failed; will retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
