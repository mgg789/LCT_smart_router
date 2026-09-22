import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { OperationContext } from '../../operations';
import type { Tx } from '../../persistence';
import { APP_STATE_KEYS } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';

export type ResetKind = 'demo' | 'empty';

export interface ResetOutcome {
  readonly kind: ResetKind;
  readonly generation: number;
  readonly startupProfile: ResetKind;
}

export interface ClearWorkingSetOptions {
  /** Keep dispatcher Dashboard sessions so the same operator can continue. */
  readonly preserveDispatcherSessions?: boolean;
  readonly startupProfile?: ResetKind;
}

/**
 * The two destructive data actions of the Dashboard.
 *
 * They are deliberately different from each other and from ordinary loading
 * (context/37 section 9.2): adding data never clears anything, "reset to test data"
 * returns to the prepared demonstration state, and "full reset" gives an empty working
 * set for collecting requests from scratch.
 *
 * Both require an explicit confirmation naming what will be affected. An AI may prepare
 * either one and may never confirm it on the dispatcher's behalf (context/42 DF-24).
 *
 * This clears **data, not the application**: source code, `.env`, the database schema, the
 * map and the knowledge sources stay, and the single dispatcher is restored from
 * configuration rather than from a hidden archive of old users (context/37 section 9.4).
 */
@Injectable()
export class ResetService {
  private readonly logger = new Logger(ResetService.name);

  constructor(private readonly publisher: SnapshotPublisher) {}

  /**
   * The confirmation a caller has to repeat back.
   *
   * Not a checkbox: the phrase names the action, so a request that arrives without having
   * been composed for this specific reset cannot succeed by accident.
   */
  static confirmationFor(kind: ResetKind): string {
    return kind === 'demo' ? 'reset to test data' : 'erase all application data';
  }

  /** Throws unless the caller repeated the exact confirmation phrase. */
  static assertConfirmation(kind: ResetKind, confirmation: string): void {
    const expected = ResetService.confirmationFor(kind);
    if (confirmation !== expected) {
      throw new SysError('CONFIRMATION_REQUIRED', 'This action needs an explicit confirmation', {
        details: {
          expected,
          affects: [
            'client and engineer accounts, roles and profiles',
            'requests with their conditions, assignments and facts',
            'working days, plans, accepted result packages and published snapshots',
            'journals, mail intents and sessions',
          ],
          preserved: ['source code', '.env', 'database schema', 'the dispatcher account'],
        },
      });
    }
  }

  async run(
    context: OperationContext,
    kind: ResetKind,
    confirmation: string,
  ): Promise<ResetOutcome> {
    ResetService.assertConfirmation(kind, confirmation);
    const { generation } = await this.clearWorkingSet(context, { startupProfile: kind });
    this.logger.warn(`Application data reset to "${kind}" state; generation ${generation}`);
    return { kind, generation, startupProfile: kind };
  }

  /**
   * Erases the working set and advances generation. Used by the confirmed Dashboard
   * reset and by the public demo-stand rewind, which then re-imports today's 14/2 day.
   */
  async clearWorkingSet(
    context: OperationContext,
    options: ClearWorkingSetOptions = {},
  ): Promise<{ generation: number }> {
    const previousPublicationSeq = await this.clearApplicationData(context.tx, {
      preserveDispatcherSessions: options.preserveDispatcherSessions === true,
    });

    // A new generation marks the boundary of the new working set, so a late write from
    // before the reset cannot be applied to it (context/37 section 9.6).
    const generation = await this.nextGeneration(context.tx, context.now);
    const profile = options.startupProfile ?? 'empty';

    // The startup profile is what stops a restart from quietly reloading the demo data:
    // an empty `requests` table is not proof that the system was never initialised
    // (context/37 section 9.5).
    await this.setState(context.tx, context.now, APP_STATE_KEYS.STARTUP_PROFILE, profile);
    await this.setState(context.tx, context.now, APP_STATE_KEYS.INITIALIZED, true);

    // The contour gets a valid, empty task through the ordinary mechanism. sys does not
    // reach into Router's memory to clear anything.
    await this.publisher.publishIfChanged(context.tx, context.now, PUBLICATION_TRIGGERS.DATA_RESET);
    await context.tx.routingCurrent.update({
      where: { id: 'singleton' },
      data: { pointerVersion: previousPublicationSeq + 1 },
    });
    return { generation };
  }

  /**
   * Removes the application's data in dependency order.
   *
   * The control mode row survives as a row but is returned to AUTO: after a deliberate
   * reset there is no manual plan left to protect, and the concept leaves the resulting
   * mode unspecified rather than requiring MANUAL to persist (context/37 section 9.3).
   */
  private async clearApplicationData(
    tx: Tx,
    options: { preserveDispatcherSessions: boolean },
  ): Promise<number> {
    const currentPublication = await tx.routingCurrent.findUnique({
      where: { id: 'singleton' },
      select: { pointerVersion: true },
    });
    await tx.appliedPlanCurrent.deleteMany({});
    await tx.appliedPlanStop.deleteMany({});
    await tx.appliedPlanRoute.deleteMany({});
    await tx.appliedPlanAssignment.deleteMany({});
    await tx.appliedPlan.deleteMany({});
    await tx.routerResult.deleteMany({});
    await tx.alert.deleteMany({});
    await tx.shiftClosure.deleteMany({});

    await tx.routingCurrent.deleteMany({});
    await tx.routingSnapshot.deleteMany({});

    // A LIVE day is generation-scoped.  It must disappear before the engineers and
    // requests it references, otherwise a coordinator tick after reset can attach the
    // newly imported crew to an old running day.
    await tx.liveWorkday.deleteMany({});

    await tx.requestFact.deleteMany({});
    await tx.requestConditionHistory.deleteMany({});
    await tx.request.deleteMany({});

    await tx.engineerDay.deleteMany({});
    await tx.engineer.deleteMany({});
    await tx.depot.deleteMany({});

    // Unsent intents of the old run are dropped: a letter about a request that no longer
    // exists must not go out later (context/42 DF-24).
    await tx.notificationIntent.deleteMany({});
    await tx.externalIdMap.deleteMany({});
    await tx.importPackage.deleteMany({});

    if (options.preserveDispatcherSessions) {
      await tx.session.deleteMany({ where: { role: { not: 'dispatcher' } } });
    } else {
      await tx.session.deleteMany({});
    }
    await tx.loginCode.deleteMany({});
    await tx.apiToken.deleteMany({});
    await tx.operation.deleteMany({});
    await tx.auditLog.deleteMany({});

    // Accounts last, and only the ones that are not the dispatcher: that account is
    // restored from configuration, and deleting it would lock the Dashboard out.
    await tx.accountRole.deleteMany({ where: { role: { in: ['client', 'engineer'] } } });
    await tx.account.deleteMany({ where: { roles: { none: {} } } });

    await tx.controlState.update({
      where: { id: 'singleton' },
      data: { mode: 'auto', frozenPlanId: null },
    });

    // Numbering starts again with the data it numbers.
    await tx.$executeRawUnsafe('ALTER SEQUENCE request_arrival_order_seq RESTART WITH 0');
    await tx.$executeRawUnsafe('ALTER SEQUENCE engineer_input_order_seq RESTART WITH 0');

    // Router keeps the latest publication sequence in memory to reject stale pointer
    // rollbacks. Reset replaces the whole working set, but its first empty publication
    // must still advance that sequence so the running Router can accept the new generation.
    return currentPublication?.pointerVersion ?? 0;
  }

  private async nextGeneration(tx: Tx, now: number): Promise<number> {
    const current = await tx.appState.findUnique({ where: { key: APP_STATE_KEYS.GENERATION } });
    const value = typeof current?.value === 'number' ? current.value : 1;
    const next = value + 1;
    await this.setState(tx, now, APP_STATE_KEYS.GENERATION, next);
    return next;
  }

  private async setState(tx: Tx, now: number, key: string, value: unknown): Promise<void> {
    await tx.appState.upsert({
      where: { key },
      update: { value: value as object, updatedAt: BigInt(now) },
      create: { key, value: value as object, updatedAt: BigInt(now) },
    });
  }
}
