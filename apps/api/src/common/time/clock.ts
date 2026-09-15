import { Injectable } from '@nestjs/common';
import { toUnixSeconds, type UnixSeconds } from './unix-seconds';

/**
 * Source of "now" for the whole application.
 *
 * Time is injected rather than read from `Date.now()` in place so that acceptance
 * scenarios can move the clock deliberately. It is also a reminder of a system rule:
 * the passage of time is never itself a trigger — it publishes no snapshot and creates
 * no execution fact (context/36 section 5.1).
 */
export abstract class Clock {
  abstract nowSeconds(): UnixSeconds;

  now(): Date {
    return new Date(this.nowSeconds() * 1000);
  }
}

@Injectable()
export class SystemClock extends Clock {
  nowSeconds(): UnixSeconds {
    return toUnixSeconds(new Date());
  }
}

/** Test double: advances only when a test tells it to. */
export class FixedClock extends Clock {
  constructor(private current: UnixSeconds) {
    super();
  }

  nowSeconds(): UnixSeconds {
    return this.current;
  }

  set(seconds: UnixSeconds): void {
    this.current = seconds;
  }

  advance(seconds: number): void {
    this.current += seconds;
  }
}
