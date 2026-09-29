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
import { canonicalTextAddress } from '../passports/passport-policy';
import { ResetService } from '../reset';
import { buildLiveDemo, liveDemoPackageSource } from './live-demo-package';

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
 * Demo-stand menu and explicit rewind. Inactive unless `DEMO_STAND=true`.
 * Startup does not import requests: the dispatcher loads a ready pack.
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
    // A schema upgrade must also seed an already-running 14-point demo without
    // resetting its workday, linked engineers or recorded execution facts.
    if (
      (await this.prisma.building.count()) === 0 &&
      (await this.prisma.request.count()) === 14 &&
      (await this.prisma.importPackage.findFirst({
        where: {
          source: liveDemoPackageSource(
            workDateOf(this.clock.nowSeconds(), this.config.get('APP_TIME_ZONE')),
          ),
        },
        select: { id: true },
      }))
    ) {
      await this.operations.execute(
        {
          operationId: randomUUID(),
          actor: SYSTEM_ACTOR,
          action: 'data.seed_passports',
          payload: {},
        },
        async (context) => {
          if ((await context.tx.building.count()) === 0)
            await this.seedObjectPassportFixture(context);
          return { seeded: true };
        },
      );
    }
  }

  /** Refuses the public restore contract when the contour is not the demo stand. */
  assertEnabled(): void {
    if (!this.enabled) {
      throw SysError.notFound('Demo stand restore');
    }
  }

  /** Kept for the live tick. A demo stand no longer imports a day by itself. */
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
   * Wipes playable state and reloads today's 14/3 package. Dispatcher sessions survive
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
    await this.seedObjectPassportFixture(context);
    if (context.actor.accountId) {
      await context.tx.aiConversation.updateMany({
        where: { accountId: context.actor.accountId, closedAt: null },
        data: { closedAt: BigInt(context.now), updatedAt: BigInt(context.now) },
      });
    }
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

  /** Seeds the 14-request public demo deterministically without a network dependency:
   * exactly three object cards remain absent while the other eleven are fresh. */
  private async seedObjectPassportFixture(context: OperationContext): Promise<void> {
    const requests = await context.tx.request.findMany({
      orderBy: { arrivalOrder: 'asc' },
      select: { addressText: true, lat: true, lon: true },
    });
    for (const [index, request] of requests.entries()) {
      const address = canonicalTextAddress(request.addressText);
      if (!address) throw new Error('Demo building address cannot be normalized');
      const building = await context.tx.building.upsert({
        where: { canonicalAddress: address },
        update: { updatedAt: BigInt(context.now) },
        create: {
          canonicalAddress: address,
          createdAt: BigInt(context.now),
          updatedAt: BigInt(context.now),
        },
      });
      if (request.lat !== null && request.lon !== null) {
        await context.tx.reverseGeocodeCache.upsert({
          where: { coordinateKey: `${request.lat.toFixed(6)},${request.lon.toFixed(6)}` },
          update: {
            canonicalAddress: address,
            provider: 'demo-fixture',
            resolvedAt: BigInt(context.now),
          },
          create: {
            coordinateKey: `${request.lat.toFixed(6)},${request.lon.toFixed(6)}`,
            canonicalAddress: address,
            provider: 'demo-fixture',
            resolvedAt: BigInt(context.now),
          },
        });
      }
      if (index < 3) continue;
      await context.tx.objectPassport.upsert({
        where: { buildingId: building.id },
        update: { updatedAt: BigInt(context.now) },
        create: {
          buildingId: building.id,
          connectionType: 'fiber',
          difficulty: 2,
          equipment: '',
          accessNotes: '',
          comment: '',
          updatedAt: BigInt(context.now),
        },
      });
    }
  }

  private async reconcileOnce(): Promise<void> {
    // Ready packs are the way to fill the day. Do not import 14/3 on startup or on a tick.
    return;
  }
}
