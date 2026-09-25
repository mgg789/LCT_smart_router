import {
  Global,
  Injectable,
  Logger,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { MonthlyReportsService } from './monthly-reports.service';
import { NotificationsModule } from './notifications.module';

/** Runs catch-up at startup and hourly while automatic mail is enabled. */
@Injectable()
export class MonthlyReportsCoordinator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonthlyReportsCoordinator.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly reports: MonthlyReportsService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.DEMO_STAND === 'true') return;
    const run = () =>
      this.reports.catchUp().catch((error: unknown) => {
        this.logger.warn(
          `Monthly report catch-up failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    void run();
    this.timer = setInterval(run, 60 * 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Monthly report snapshots and dispatcher mail intents. */
@Global()
@Module({
  imports: [NotificationsModule],
  providers: [MonthlyReportsService, MonthlyReportsCoordinator],
  exports: [MonthlyReportsService, MonthlyReportsCoordinator],
})
export class MonthlyReportsModule {}
