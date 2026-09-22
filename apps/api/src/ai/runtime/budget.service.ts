import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import { PrismaService } from '../../persistence';

export interface BudgetReservation {
  readonly quotaDay: string;
  readonly reservedMicros: number;
}

export interface BudgetQuota {
  readonly quotaDay: string;
  readonly remainingMicros: number;
  readonly remainingMessages: number;
  readonly resetAt: number;
}

/**
 * The account's daily AI allowance: one row per (quota day, account), reserved before a
 * run starts and settled once real usage is known.
 *
 * Raw SQL is the correct tool for {@link reserve}, not an escape hatch from Prisma: the
 * `AiBudget` model's own schema comment names this exact statement as "the correctness
 * anchor for an atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE reservation", because
 * two browser tabs racing a synchronous "read the remaining balance, then decide" would
 * otherwise both read room and both reserve. Putting the limit check in the `WHERE` of
 * the same statement that performs the write closes that window -- there is no separate
 * "check" step for a second request to land inside of. This mirrors why
 * `persistence/row-locks.ts` reaches for raw SQL: Prisma has no portable way to express
 * a guarded upsert either.
 *
 * Postgres evaluates the `WHERE` of `ON CONFLICT ... DO UPDATE` only when a row already
 * exists; the plain `INSERT` that wins on the first reservation of a (quota day, account)
 * would otherwise be unconditional. That matters for the lifetime cap specifically: an
 * account that has already spent its total would get one free run on each new day, which
 * is exactly the guard that a small fixed budget depends on. The insert therefore draws
 * its row from a `SELECT ... WHERE` instead of from `VALUES`, so an over-budget account
 * produces no source row, no insert, and an empty `RETURNING` -- the same refusal the
 * update branch gives.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
  ) {}

  quotaDayFor(nowSeconds: number): string {
    return quotaDayKey(nowSeconds, this.config.get('APP_TIME_ZONE'));
  }

  /** Reserves one run's estimated cost and one message slot, or throws
   *  `AI_QUOTA_EXHAUSTED` when the daily message count, the daily cost cap or the
   *  account's lifetime cost cap would be exceeded. */
  async reserve(accountId: string): Promise<BudgetReservation> {
    const now = this.clock.nowSeconds();
    const quotaDay = this.quotaDayFor(now);
    const estimateMicros = this.config.get('AI_RUN_ESTIMATE_MICROS');
    const dailyCostLimit = this.config.get('AI_DAILY_COST_LIMIT_MICROS');
    const dailyMessageLimit = this.config.get('AI_DAILY_MESSAGE_LIMIT');
    const totalCostLimit = this.config.get('AI_TOTAL_COST_LIMIT_MICROS');

    const rows = await this.prisma.$queryRaw<Array<{ reserved_micros: number }>>`
      INSERT INTO ai_budgets (quota_day, account_id, reserved_micros, settled_micros, message_count, updated_at, version)
      SELECT ${quotaDay}, ${accountId}, ${estimateMicros}, 0, 1, ${BigInt(now)}, 1
      WHERE ${estimateMicros} <= ${dailyCostLimit}
        AND 1 <= ${dailyMessageLimit}
        AND (
          SELECT COALESCE(SUM(reserved_micros + settled_micros), 0)
          FROM ai_budgets
          WHERE account_id = ${accountId}
        ) + ${estimateMicros} <= ${totalCostLimit}
      ON CONFLICT (quota_day, account_id) DO UPDATE SET
        reserved_micros = ai_budgets.reserved_micros + EXCLUDED.reserved_micros,
        message_count = ai_budgets.message_count + 1,
        updated_at = EXCLUDED.updated_at,
        version = ai_budgets.version + 1
      WHERE ai_budgets.reserved_micros + ai_budgets.settled_micros + ${estimateMicros} <= ${dailyCostLimit}
        AND ai_budgets.message_count + 1 <= ${dailyMessageLimit}
        AND (
          SELECT COALESCE(SUM(reserved_micros + settled_micros), 0)
          FROM ai_budgets
          WHERE account_id = ${accountId}
        ) + ${estimateMicros} <= ${totalCostLimit}
      RETURNING reserved_micros
    `;
    if (rows.length === 0) {
      throw new SysError('AI_QUOTA_EXHAUSTED', 'The AI quota for this account is spent for today', {
        details: { quotaDay },
      });
    }
    return { quotaDay, reservedMicros: estimateMicros };
  }

  /** Turns a reservation into real usage: gives back the estimate, charges what the
   *  provider actually reported. Never throws -- a settlement is bookkeeping, not a gate,
   *  and a run whose answer already reached the client must not fail on the way out. */
  async settle(
    reservation: BudgetReservation,
    accountId: string,
    actualMicros: number,
  ): Promise<void> {
    const now = this.clock.nowSeconds();
    await this.prisma.$executeRaw`
      UPDATE ai_budgets
      SET reserved_micros = GREATEST(reserved_micros - ${reservation.reservedMicros}, 0),
          settled_micros = settled_micros + ${actualMicros},
          updated_at = ${BigInt(now)},
          version = version + 1
      WHERE quota_day = ${reservation.quotaDay} AND account_id = ${accountId}
    `;
  }

  /** Read-only snapshot for the `quota` run event; never itself reserves anything. */
  async snapshot(accountId: string): Promise<BudgetQuota> {
    const now = this.clock.nowSeconds();
    const quotaDay = this.quotaDayFor(now);
    const row = await this.prisma.aiBudget.findUnique({
      where: { quotaDay_accountId: { quotaDay, accountId } },
    });
    const dailyCostLimit = this.config.get('AI_DAILY_COST_LIMIT_MICROS');
    const dailyMessageLimit = this.config.get('AI_DAILY_MESSAGE_LIMIT');
    const spentMicros = row ? row.reservedMicros + row.settledMicros : 0;
    const messageCount = row?.messageCount ?? 0;
    return {
      quotaDay,
      remainingMicros: Math.max(dailyCostLimit - spentMicros, 0),
      remainingMessages: Math.max(dailyMessageLimit - messageCount, 0),
      resetAt: nextQuotaDayResetAt(now, this.config.get('APP_TIME_ZONE')),
    };
  }
}

/** `YYYY-MM-DD` of `atSeconds` in `timeZone`, the natural key of one quota day. */
function quotaDayKey(atSeconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atSeconds * 1000));
}

function timeZoneOffsetSeconds(atSeconds: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(atSeconds * 1000));
  const tzName = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!match) {
    return 0;
  }
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  return sign * (hours * 3600 + minutes * 60);
}

/**
 * Unix seconds of the next local midnight in `timeZone`.
 *
 * Approximate by design: it assumes the zone's current UTC offset still holds at that
 * midnight, which is only wrong when a DST transition falls inside the remaining window.
 * This value drives a UI countdown, never an accounting decision, so that rare one-hour
 * skew is an acceptable trade for not pulling a full time-zone database into the runtime.
 */
function nextQuotaDayResetAt(nowSeconds: number, timeZone: string): number {
  const offsetSeconds = timeZoneOffsetSeconds(nowSeconds, timeZone);
  const localNow = nowSeconds + offsetSeconds;
  const nextLocalMidnight = (Math.floor(localNow / 86_400) + 1) * 86_400;
  return nextLocalMidnight - offsetSeconds;
}
