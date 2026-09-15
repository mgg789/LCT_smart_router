import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { assertNoBigInt } from '../time/bigint-boundary';

/**
 * Fails loudly when a `bigint` from the database reaches the response encoder.
 *
 * Without this the mistake is invisible until a consumer receives a string where the
 * contract promises a number. Disabled in production, where the scan over every payload
 * costs more than it is worth once the boundary conversions are covered by tests.
 */
@Injectable()
export class BigIntGuardInterceptor implements NestInterceptor {
  constructor(private readonly enabled: boolean) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.enabled) {
      return next.handle();
    }
    return next.handle().pipe(
      map((payload) => {
        assertNoBigInt(payload);
        return payload;
      }),
    );
  }
}
