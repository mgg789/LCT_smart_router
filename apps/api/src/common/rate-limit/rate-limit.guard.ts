import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfigService } from '../config';
import { SysError } from '../errors';

export const RATE_LIMIT_METADATA = 'rate_limit_rule';

export interface RateLimitRule {
  /**
   * Bucket identity: endpoints that share one budget share a scope name, endpoints
   * with independent budgets do not. Scope names must stay stable -- they are part
   * of what a client's requests are counted against.
   */
  readonly scope: string;
  /** Maximum requests per window from one client address. */
  readonly max: number;
  /** Window length in seconds; the window starts with the request that opens it. */
  readonly windowSec: number;
}

/**
 * Declares a per-client request budget on a route. Pair with `@UseGuards(RateLimitGuard)`.
 * Meant for the unauthenticated surfaces whose cost is not the CPU but something paid:
 * password guessing, code issuing, LocationIQ and LLM proxying.
 */
export const RateLimit = (rule: RateLimitRule): MethodDecorator =>
  SetMetadata(RATE_LIMIT_METADATA, rule);

interface Bucket {
  readonly windowStart: number;
  count: number;
}

/** Fixed-window counters, one per (scope, client address). Process-local by design:
 *  the contour runs one API instance, and a shared store would add a failure mode to
 *  a guard whose only job is to make abuse slightly expensive. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly reflector: Reflector,
    private readonly config: AppConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
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
    const max = rule.max * this.config.get('RATE_LIMIT_MULTIPLIER');
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      ip?: string;
    }>();
    const key = `${rule.scope}:${clientAddress(request)}`;
    const now = Date.now();
    this.prune(now);
    const bucket = this.buckets.get(key);
    if (bucket === undefined || now - bucket.windowStart >= rule.windowSec * 1000) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      throw new SysError('RATE_LIMITED', 'Слишком много запросов; повторите через минуту.');
    }
    return true;
  }

  /** The map only ever grows; once it is large, drop everything past a fixed age so a
   *  spray of unique addresses cannot turn the guard into the memory leak it guards
   *  against. An hour covers any window this codebase sets. */
  private prune(now: number): void {
    if (this.buckets.size < 10_000) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= 3_600_000) {
        this.buckets.delete(key);
      }
    }
  }
}

/**
 * The client address the proxy chain saw first. Our own nginx hops append the previous
 * address to `X-Forwarded-For`, so without proxies this falls back to the socket peer.
 * A spoofed first entry only moves the caller into its own bucket: the request is still
 * served and still counted, and the real peer stays in the chain for the log.
 */
function clientAddress(request: {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }
  return request.ip ?? 'unknown';
}
