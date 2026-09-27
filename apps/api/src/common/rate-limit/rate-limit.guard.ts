import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../persistence';
import { AppConfigService } from '../config';
import { SysError } from '../errors';

export const RATE_LIMIT_METADATA = 'rate_limit_rule';
export const PRE_AUTH_RATE_LIMIT_METADATA = 'pre_auth_rate_limit_rule';

export interface RateLimitRule {
  /**
   * Bucket identity: endpoints that share one budget share a scope name, endpoints
   * with independent budgets do not. Scope names must stay stable -- they are part
   * of what a client's requests are counted against.
   */
  readonly scope: string;
  /** Maximum requests per window from one client address. */
  readonly max: number;
  /** Window length in seconds; windows are aligned to Unix epoch boundaries. */
  readonly windowSec: number;
}

/**
 * Declares a per-client request budget enforced once by the global RateLimitGuard.
 * Meant for the unauthenticated surfaces whose cost is not the CPU but something paid:
 * password guessing, code issuing, LocationIQ and LLM proxying.
 */
export const RateLimit = (rule: RateLimitRule): MethodDecorator =>
  SetMetadata(RATE_LIMIT_METADATA, rule);

/**
 * Declares a budget that must run before the global authentication guard resolves a
 * credential. Use this only for public credential endpoints whose invalid credentials
 * are otherwise expensive to resolve (for example the MCP transport).
 */
export const PreAuthRateLimit = (rule: RateLimitRule): MethodDecorator =>
  SetMetadata(PRE_AUTH_RATE_LIMIT_METADATA, rule);

/**
 * Fixed-window counters persisted in PostgreSQL. The unique bucket key and atomic
 * `ON CONFLICT` increment make concurrent requests from several API instances share one
 * budget; there is no read-then-write race and no process-local bypass.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private lastCleanupAt = 0;

  constructor(
    protected readonly reflector: Reflector,
    protected readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rule) {
      return true;
    }
    // An operator whose edge already rate-limits (nginx, an API gateway) can raise
    // every budget at once; the integration suites raise it so a whole test file
    // signing in from one loopback address does not trip the auth budgets.
    return this.enforce(context, rule);
  }

  protected async enforce(context: ExecutionContext, rule: RateLimitRule): Promise<boolean> {
    const max = rule.max * this.config.get('RATE_LIMIT_MULTIPLIER');
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      ip?: string;
    }>();
    const clientKey = clientAddress(request);
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSec / rule.windowSec) * rule.windowSec;
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO rate_limit_buckets
        (scope, client_key, window_start, count, updated_at)
      VALUES
        (${rule.scope}, ${clientKey}, ${BigInt(windowStart)}, 1, ${BigInt(nowSec)})
      ON CONFLICT (scope, client_key, window_start)
      DO UPDATE SET
        count = rate_limit_buckets.count + 1,
        updated_at = EXCLUDED.updated_at
      RETURNING count
    `;
    const count = rows[0]?.count;
    if (count === undefined || count > max) {
      throw new SysError('RATE_LIMITED', 'Слишком много запросов; повторите через минуту.');
    }
    await this.cleanup(nowSec);
    return true;
  }

  /** Periodically removes old buckets so unique-address sprays cannot grow the table forever. */
  private async cleanup(nowSec: number): Promise<void> {
    if (nowSec - this.lastCleanupAt < 300) {
      return;
    }
    this.lastCleanupAt = nowSec;
    await this.prisma.$executeRaw`
      DELETE FROM rate_limit_buckets
      WHERE window_start < ${BigInt(nowSec - 86_400)}
    `;
  }
}

/**
 * Applies a pre-authentication budget. It is registered globally before ActorGuard so
 * invalid bearer values and invalid header credentials consume the same client budget.
 */
@Injectable()
export class PreAuthRateLimitGuard extends RateLimitGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(
      PRE_AUTH_RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!rule) {
      return true;
    }
    return this.enforce(context, rule);
  }
}

/**
 * Uses Express' trusted address. This app does not configure proxy trust, so accepting
 * `X-Forwarded-For` here would let a caller mint a fresh bucket on every request. Behind
 * a shared reverse proxy, all callers therefore share the proxy's `req.ip` bucket until
 * a trusted proxy chain is configured explicitly at the application boundary.
 */
function clientAddress(request: { ip?: string }): string {
  return request.ip ?? 'unknown';
}
