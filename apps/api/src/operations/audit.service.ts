import { Injectable } from '@nestjs/common';
import type { Actor } from '../auth';
import { PrismaService, type Tx } from '../persistence';

export interface AuditEntry {
  readonly actor: Actor;
  readonly action: string;
  readonly targetRef?: string | null;
  readonly operationId?: string | null;
  /** Facts worth keeping for a later explanation. Never secrets. */
  readonly details?: Record<string, unknown>;
  /** Absolute second after which the row may be cleared. */
  readonly retainUntil?: number | null;
}

/**
 * The journal context/37 section 6.2 calls `eternal-log`, where the user made a point of
 * saying that "eternal" is only a name and the data needs a lifetime -- hence
 * `retainUntil`.
 *
 * Its job is to answer "who changed this, from where, and on the basis of what": a human
 * through the UI, an integration key, or (later) an AI run acting on someone's behalf
 * (context/36 section 8). The source is recorded next to the authority, and it never
 * substitutes for it.
 *
 * Writes go through the caller's transaction on purpose: the business change and the
 * record of who made it are saved together or not at all.
 */
/** Who made a recorded change, as the request history shows it. Never a secret. */
export interface AuditActorView {
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly source: string;
  readonly action: string;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Actors for the given operation ids.
   *
   * The journal is written in the same transaction as the change and is the place that
   * answers who did it. Callers that already list operations or condition history use
   * this instead of leaving the rows unread.
   */
  async actorsFor(operationIds: readonly string[]): Promise<Map<string, AuditActorView>> {
    const ids = [...new Set(operationIds.filter((id) => id.length > 0))];
    const found = new Map<string, AuditActorView>();
    if (ids.length === 0) return found;
    const rows = await this.prisma.auditLog.findMany({
      where: { operationId: { in: ids } },
      orderBy: { at: 'asc' },
    });
    for (const row of rows) {
      if (!row.operationId || found.has(row.operationId)) continue;
      found.set(row.operationId, {
        actorKind: row.actorKind,
        actorId: row.actorId,
        source: row.source,
        action: row.action,
      });
    }
    return found;
  }

  async record(tx: Tx, at: number, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        at: BigInt(at),
        actorKind: entry.actor.kind,
        actorId: entry.actor.id,
        source: entry.actor.source,
        action: entry.action,
        targetRef: entry.targetRef ?? null,
        operationId: entry.operationId ?? null,
        details: (entry.details ?? {}) as object,
        retainUntil:
          entry.retainUntil === undefined || entry.retainUntil === null
            ? null
            : BigInt(entry.retainUntil),
      },
    });
  }
}
