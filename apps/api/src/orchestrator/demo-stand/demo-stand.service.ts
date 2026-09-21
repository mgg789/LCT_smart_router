import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Actor } from '../../auth';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import type { OperationContext } from '../../operations';
import { OperationsService } from '../../operations';
import { PrismaService } from '../../persistence';
import { workDateOf } from '../engineers/workday';
import { UploadImportService } from '../imports';
import { ResetService } from '../reset';
import {
  buildLiveDemo,
  LIVE_DEMO_PACKAGE_PREFIX,
  liveDemoPackageSource,
} from './live-demo-package';

export interface DemoStandRestoreOutcome {
  readonly restored: true;
  readonly workDate: string;
  readonly requestsCreated: number;
  readonly engineersCreated: number;
  readonly generation: number;
}

const SYSTEM_ACTOR: Actor = {
  kind: 'system',
  id: 'demo-stand',
  source: 'system',
  role: null,
  tokenCategory: null,
  accountId: null,
};

/**
 * Public-contour 14/2 live-demo: today's Moscow windows, 30-minute days, and a wipe that
 * keeps the dispatcher signed in. Inactive unless `DEMO_STAND=true`.
 */
@Injectable()
export class DemoStandService implements OnModuleInit {
  private readonly logger = new Logger(DemoStandService.name);
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly operations: OperationsService,
    private readonly reset: ResetService,
    private readonly uploads: UploadImportService,
  ) {}

  get enabled(): boolean {
    // Read the live process flag so integration tests can enable the contour after
    // AppModule was first imported in the same Node process (ConfigModule caches).
    return process.env.DEMO_STAND === 'true';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    await this.reconcileOnce();
  }

  /** Refuses the public restore contract when the contour is not the demo stand. */
  assertEnabled(): void {
    if (!this.enabled) {
      throw SysError.notFound('Demo stand restore');
    }
  }

  /**
   * Seeds or rewinds the 14/2 day when the stand is empty, dated for another Moscow day,
   * or already finished. A running day is left alone.
   */
  reconcile(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const current = this.reconcileOnce()
      .catch((error: unknown) => {
        this.logger.warn(
          `Demo stand reconcile failed; will retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.inFlight === current) this.inFlight = null;
      });
    this.inFlight = current;
    return current;
  }

  /**
   * Wipes playable state and reloads today's 14/2 package. Dispatcher sessions survive
   * so the same operator can start the day again without signing in.
   */
  async restore(context: OperationContext): Promise<DemoStandRestoreOutcome> {
    this.assertEnabled();
    const workDate = workDateOf(context.now, this.config.get('APP_TIME_ZONE'));
    const { generation } = await this.reset.clearWorkingSet(context, {
      preserveDispatcherSessions: true,
      startupProfile: 'demo',
    });
    const packageInput = buildLiveDemo(workDate, this.config.get('DATASET_ROOT'));
    const summary = await this.uploads.importPackage(
      context,
      packageInput,
      this.config.get('DATASET_TIME_ZONE_OFFSET_SEC'),
    );
    this.logger.warn(
      `Demo stand restored ${summary.requestsCreated} requests / ${summary.engineersCreated} engineers for ${workDate}`,
    );
    return {
      restored: true,
      workDate,
      requestsCreated: summary.requestsCreated,
      engineersCreated: summary.engineersCreated,
      generation,
    };
  }

  private async reconcileOnce(): Promise<void> {
    if (!(await this.needsRestore(this.clock.nowSeconds()))) return;
    await this.operations.execute(
      {
        operationId: randomUUID(),
        actor: SYSTEM_ACTOR,
        action: 'data.restart_demo',
        payload: { reason: 'auto' },
      },
      (context) => this.restore(context),
    );
  }

  private async needsRestore(now: number): Promise<boolean> {
    const workDate = workDateOf(now, this.config.get('APP_TIME_ZONE'));
    const running = await this.prisma.liveWorkday.findFirst({
      where: { status: 'running' },
      select: { id: true, workDate: true },
    });
    if (running) return running.workDate !== workDate;

    const finished = await this.prisma.liveWorkday.findFirst({
      where: { status: 'finished' },
      select: { id: true },
    });
    if (finished) return true;

    const expectedSource = liveDemoPackageSource(workDate);
    const latest = await this.prisma.importPackage.findFirst({
      where: { source: { startsWith: LIVE_DEMO_PACKAGE_PREFIX } },
      orderBy: { appliedAt: 'desc' },
      select: { source: true },
    });
    if (!latest || latest.source !== expectedSource) return true;

    const requestCount = await this.prisma.request.count();
    return requestCount === 0;
  }
}
