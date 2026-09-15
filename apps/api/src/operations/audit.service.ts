import { Injectable } from '@nestjs/common';
import type { Actor } from '../auth';
import type { Tx } from '../persistence';

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
@Injectable()
export class AuditService {
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
