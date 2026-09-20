import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { AlertsService } from './alerts.service';

/** Runs time-based alert detection even when no dispatcher tab happens to be open. */
@Injectable()
export class AlertCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertCoordinator.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit(): void {
    if (this.config.isTest) return;
    this.timer = setInterval(
      () => void this.runOnce(),
      Math.max(15_000, this.config.get('ROUTER_POLL_INTERVAL_MS')),
    );
    this.timer.unref();
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const work = this.alerts
      .refreshAll()
      .catch((error: unknown) => {
        this.logger.error(
          `Alert detection failed; will retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    return work;
  }
}
