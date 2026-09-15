import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

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
   * Runs one business change and everything that must be consistent with it.
   *
   * The rule this exists to enforce: a business write, the record of who made it and the
   * intent of the follow-up actions it requires are saved together (context/36
   * section 1). Waiting on Router, AI or SMTP is explicitly *not* part of that unit --
   * a network call must never hold the transaction open, and a mail failure must not
   * turn an already saved request into a non-existent one.
   */
  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => fn(tx));
  }
}
