import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import type { OperationContext } from '../../operations';
import { APP_STATE_KEYS, PrismaService, type Tx } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import { workDateOf } from '../engineers/workday';
import {
  type DispatcherSettings,
  type DispatcherSettingsPatch,
  type DispatcherSettingsView,
  mergeDispatcherSettings,
  moscowMinutesToUnix,
  parseDispatcherSettings,
  toDispatcherSettingsView,
} from './dispatcher-settings';

/**
 * Dispatcher-owned operational settings stored in `app_state`.
 *
 * Router technical settings stay on Router Core. These rows cover the day clock,
 * alert-only timers and map-provider secrets that sys itself applies.
 */
@Injectable()
export class DispatcherSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly publisher: SnapshotPublisher,
  ) {}

  async read(db: PrismaService | Tx = this.prisma): Promise<DispatcherSettings> {
    const row = await db.appState.findUnique({
      where: { key: APP_STATE_KEYS.DISPATCHER_SETTINGS },
    });
    return parseDispatcherSettings(row?.value ?? null);
  }

  async view(): Promise<DispatcherSettingsView> {
    return toDispatcherSettingsView(await this.read());
  }

  /**
   * Replaces the persisted row and, when the day clock moved, rewrites today's shifts
   * so the UI value is the one Router and LIVE actually use.
   */
  async replace(
    context: OperationContext,
    patch: DispatcherSettingsPatch,
  ): Promise<DispatcherSettingsView> {
    const current = await this.read(context.tx);
    let next: DispatcherSettings;
    try {
      next = mergeDispatcherSettings(current, patch);
    } catch (error) {
      throw new SysError(
        'VALIDATION_FAILED',
        error instanceof Error ? error.message : 'Invalid dispatcher settings',
      );
    }

    await context.tx.appState.upsert({
      where: { key: APP_STATE_KEYS.DISPATCHER_SETTINGS },
      create: {
        key: APP_STATE_KEYS.DISPATCHER_SETTINGS,
        value: next,
        updatedAt: BigInt(context.now),
      },
      update: {
        value: next,
        updatedAt: BigInt(context.now),
      },
    });

    const dayChanged =
      current.dayStartMin !== next.dayStartMin || current.dayEndMin !== next.dayEndMin;
    if (dayChanged) {
      await this.applyDayBounds(context, next);
    }
    return toDispatcherSettingsView(next);
  }

  private async applyDayBounds(
    context: OperationContext,
    settings: DispatcherSettings,
  ): Promise<void> {
    const timeZone = this.config.get('APP_TIME_ZONE');
    const workDate = workDateOf(context.now, timeZone);
    const shiftStartAt = moscowMinutesToUnix(workDate, settings.dayStartMin);
    const shiftEndAt = moscowMinutesToUnix(workDate, settings.dayEndMin);
    const updated = await context.tx.engineerDay.updateMany({
      where: { workDate },
      data: {
        shiftStartAt: BigInt(shiftStartAt),
        shiftEndAt: BigInt(shiftEndAt),
        updatedAt: BigInt(context.now),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      return;
    }
    await this.publisher.publishIfChanged(
      context.tx,
      context.now,
      PUBLICATION_TRIGGERS.ENGINEER_WORKDAY_CHANGED,
    );
  }
}
