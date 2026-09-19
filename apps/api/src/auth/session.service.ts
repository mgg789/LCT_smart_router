import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../common/config';
import { Clock } from '../common/time';
import type { Role } from '../generated/prisma/client';
import { PrismaService } from '../persistence';
import type { Actor } from './actor';
import { generateToken, hashToken } from './secrets';

export interface IssuedSession {
  /** Returned once, to the caller that authenticated. Only its hash is stored. */
  readonly token: string;
  readonly expiresAt: number;
  readonly role: Role;
  readonly accountId: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
  ) {}

  async create(accountId: string, role: Role): Promise<IssuedSession> {
    const now = this.clock.nowSeconds();
    const ttlSec =
      role === 'engineer'
        ? this.config.get('ENGINEER_SESSION_TTL_SEC')
        : this.config.get('SESSION_TTL_SEC');
    const expiresAt = now + ttlSec;
    const token = generateToken();

    await this.prisma.session.create({
      data: {
        accountId,
        role,
        tokenHash: hashToken(token),
        createdAt: BigInt(now),
        expiresAt: BigInt(expiresAt),
      },
    });

    return { token, expiresAt, role, accountId };
  }

  /**
   * Resolves a bearer token to an actor, or null if it is not a live session.
   *
   * Expiry is checked against the stored value rather than trusted from a token claim:
   * a saved session row does not extend a session indefinitely, and a restart must not
   * revive one that has run out (context/37 section 8).
   */
  async resolve(token: string): Promise<Actor | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!session || session.revokedAt !== null) {
      return null;
    }
    if (session.expiresAt <= BigInt(this.clock.nowSeconds())) {
      return null;
    }
    return {
      kind: 'account',
      source: 'ui',
      id: session.accountId,
      role: session.role,
      tokenCategory: null,
      accountId: session.accountId,
    };
  }

  /** Idempotent: signing out twice is not an error. */
  async revoke(token: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: BigInt(this.clock.nowSeconds()) },
    });
  }
}
