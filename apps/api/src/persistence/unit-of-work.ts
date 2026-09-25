import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { lockControlState, lockRoutingCurrent } from './row-locks';

/**
 * Transaction handle passed to every write path.
 *
 * Services accept this type instead of the root client so that a handler cannot
 * accidentally escape the transaction it was given.
 */
export type Tx = Prisma.TransactionClient;

@Injectable()
export class UnitOfWork {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads and login-only writes. They must not take the routing singletons.
   *
   * `run` reserves those rows for the whole transaction. A live poll does that on
   * every request, so a plan apply or a clock tick left login, mail codes and the
   * next poll waiting on one lock until the browser gave up at 12 seconds.
   */
  observe<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: 15_000 });
  }

  /**
   * A business write that does not publish or accept a plan.
   *
   * Granting or replacing an engineer login only touches the account, the role
   * and the profile's login pointer. Reserving the routing singletons here made
   * that save wait behind result acceptance until the browser aborted at 12 seconds.
   */
  runIsolated<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn, { timeout: 15_000 });
  }

  /**
   * Runs one business change and everything that must be consistent with it.
   *
   * The rule this exists to enforce: a business write, the record of who made it and the
   * intent of the follow-up actions it requires are saved together (context/36
   * section 1). Waiting on Router, AI or SMTP is explicitly *not* part of that unit --
   * a network call must never hold the transaction open, and a mail failure must not
   * turn an already saved request into a non-existent one.
   */
  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    // A complete three-region import writes hundreds of rows and publishes its snapshot
    // in the same atomic unit. Prisma's five-second interactive-transaction default is
    // shorter than that valid operation on Docker Desktop, so the boundary carries an
    // explicit ceiling while preserving one all-or-nothing commit.
    return this.prisma.$transaction(async (tx) => {
      // Every business transaction reserves the two routing singletons in this order
      // before touching domain rows. A submission can write a request and publish while
      // acceptance reads control mode and writes that same request; taking the locks only
      // at those later call sites would make that interleaving an AB/BA deadlock.
      //
      // Bootstrap creates control_state before the application accepts work. routing_current
      // may be absent until the first publication, but control_state still serialises that
      // first publication with every other UnitOfWork transaction.
      await lockControlState(tx);
      await lockRoutingCurrent(tx);
      return fn(tx);
    }, { timeout: 60_000 });
  }
}
