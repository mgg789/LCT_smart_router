import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { LiveService } from './live.service';

/**
 * Advances durable automatic LIVE transitions while the API is up. Reads also call the
 * same method, so a restarted process never depends on an in-memory interval having run.
 */
@Injectable()
export class LiveCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LiveCoordinator.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly live: LiveService,
  ) {}

  onModuleInit(): void {
    if (this.config.isTest) return;
    this.timer = setInterval(() => void this.runOnce(), 1_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Single-flight and failure-contained like Router/overrun background coordinators. */
  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const current = this.live
      .advanceOnce()
      .catch((error: unknown) => {
        this.logger.warn(
          `LIVE advance failed; will retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.inFlight === current) this.inFlight = null;
      });
    this.inFlight = current;
    return current;
  }
}
