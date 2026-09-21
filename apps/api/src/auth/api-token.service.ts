import { Injectable } from '@nestjs/common';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import type { ApiTokenCategory } from '../generated/prisma/client';
import { PrismaService } from '../persistence';
import type { Actor } from './actor';
import { generateToken, hashToken } from './secrets';

export interface CreatedApiToken {
  readonly id: string;
  readonly name: string;
  readonly category: ApiTokenCategory;
  readonly createdAt: number;
  /** Unix-epoch seconds, or null for a key that never expires. */
  readonly expiresAt: number | null;
  /** Shown exactly once. Losing it means creating a new key (context/41 section 4.3). */
  readonly token: string;
}

export interface ApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly category: ApiTokenCategory;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

/**
 * Integration keys of the single dispatcher.
 *
 * A key carries a name, a category and an optional expiry, and holds full access inside
 * that category: no scopes, no binding to an end user (context/41 sections 3-5). NULL
 * expiry is the deliberate never-expiring key; a passed date stops new calls exactly
 * like a revocation (2026-09-19 amendment to context/41 section 4.2). A `client` or
 * `eng` key never gains dispatcher functions just because the same person owns it.
 */
@Injectable()
export class ApiTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async create(
    name: string,
    category: ApiTokenCategory,
    expiresAt: number | null,
  ): Promise<CreatedApiToken> {
    const now = this.clock.nowSeconds();
    if (expiresAt !== null && expiresAt <= now) {
      throw SysError.validationFailed('The expiry date must be in the future', { expiresAt });
    }
    const token = generateToken();
    const created = await this.prisma.apiToken.create({
      data: {
        name,
        category,
        tokenHash: hashToken(token),
        createdAt: BigInt(now),
        ...(expiresAt === null ? {} : { expiresAt: BigInt(expiresAt) }),
      },
    });
    return { id: created.id, name, category, createdAt: now, expiresAt, token };
  }

  async list(): Promise<ApiTokenSummary[]> {
    const tokens = await this.prisma.apiToken.findMany({ orderBy: { createdAt: 'desc' } });
    // The stored hash is never part of a listing: a record of a key is not the key.
    return tokens.map((token) => ({
      id: token.id,
      name: token.name,
      category: token.category,
      createdAt: Number(token.createdAt),
      expiresAt: token.expiresAt === null ? null : Number(token.expiresAt),
      revokedAt: token.revokedAt === null ? null : Number(token.revokedAt),
    }));
  }

  /**
   * Stops a key from authorising new calls.
   *
   * It does not delete the requests created with it and does not roll back changes it
   * already made (context/41 section 4.3).
   */
  async revoke(id: string): Promise<void> {
    const revoked = await this.prisma.apiToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: BigInt(this.clock.nowSeconds()) },
    });
    if (revoked.count === 0) {
      const exists = await this.prisma.apiToken.findUnique({ where: { id } });
      if (!exists) {
        throw SysError.notFound('API token', { id });
      }
      // Already revoked: repeating the operation is not an error.
    }
  }

  async resolve(token: string): Promise<Actor | null> {
    const record = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!record || record.revokedAt !== null) {
      return null;
    }
    if (record.expiresAt !== null && Number(record.expiresAt) <= this.clock.nowSeconds()) {
      // An expired key is indistinguishable from a revoked one to the caller: both are
      // simply no longer valid credentials.
      return null;
    }
    return {
      kind: 'api_token',
      source: 'external_api',
      id: record.id,
      role: null,
      tokenCategory: record.category,
      // The key belongs to the dispatcher, not to the subject of the request it acts on.
      // An object id in the payload selects the object; it never identifies the caller
      // (context/41 section 3.2).
      accountId: null,
    };
  }
}
