import { Injectable, Logger } from '@nestjs/common';
import { canonicalHash, canonicalJson } from '../../common/json';
import type { Tx } from '../../persistence';
import { lockRoutingCurrent } from '../../persistence';
import type { PublicationTrigger } from './publication-triggers';
import { SnapshotBuilder } from './snapshot.builder';

export interface PublicationOutcome {
  /** False when the projection is byte-identical to the one already published. */
  readonly published: boolean;
  readonly inputHash: string;
  readonly planningAsOf: number;
  readonly snapshotId: string | null;
}

/**
 * `mount-data-eng`: publishes the whole current planning task.
 *
 * Two rules govern when this runs, and both are about *not* running:
 *
 *   * only a listed business trigger publishes. The passage of time, a GPS point, a
 *     routine execution mark and an engineer's silence are not triggers, and there is no
 *     timer anywhere in the System Layer (context/36 section 5.1);
 *   * even on a real trigger, a projection identical to the published one is not
 *     republished, and `planning_as_of` does not move. Re-writing the same content must
 *     not produce an endless series of new timestamps (context/33 section 7).
 *
 * The insert and the pointer switch happen in one transaction, with the pointer locked
 * first, so a slow publisher cannot move the active snapshot back to an older projection
 * (context/37 section 4.2).
 */
@Injectable()
export class SnapshotPublisher {
  private readonly logger = new Logger(SnapshotPublisher.name);

  constructor(private readonly builder: SnapshotBuilder) {}

  /**
   * Builds the projection and publishes it if it differs from the current one.
   *
   * Runs inside the caller's transaction: the business change and the publication it
   * implies are saved together, so a saved change can never silently fail to reach Router
   * (context/36 section 1).
   */
  async publishIfChanged(
    tx: Tx,
    planningAsOf: number,
    trigger: PublicationTrigger,
  ): Promise<PublicationOutcome> {
    await lockRoutingCurrent(tx);

    const { snapshot, diagnostics, taskFingerprint } = await this.builder.build(tx, planningAsOf);

    // The document is serialized once and both stored and hashed from that same string.
    // Re-serializing for the hash would leave room for the two to differ.
    const payload = canonicalJson(snapshot);
    const inputHash = canonicalHash(snapshot);

    const current = await tx.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });

    // Compared on the task, not on the document: the document carries `planning_as_of`,
    // so comparing hashes would report a change every second and the timestamp would tick
    // -- which is exactly what the contract forbids. The check happens before the time is
    // stamped (context/33 section 7).
    if (current && current.snapshot.taskFingerprint === taskFingerprint) {
      // Nothing about the task changed. The trigger was real, the content was not.
      return {
        published: false,
        inputHash,
        planningAsOf: Number(current.snapshot.planningAsOf),
        snapshotId: current.snapshotId,
      };
    }

    const generation = current?.snapshot.generation ?? 1;
    const created = await tx.routingSnapshot.create({
      data: {
        payload,
        inputHash,
        taskFingerprint,
        // Stamped with this publication of changed data, not by a separate clock.
        planningAsOf: BigInt(planningAsOf),
        createdAt: BigInt(planningAsOf),
        trigger,
        generation,
        diagnostics: { ...diagnostics },
      },
    });

    await tx.routingCurrent.upsert({
      where: { id: 'singleton' },
      update: {
        snapshotId: created.id,
        pointerVersion: { increment: 1 },
        updatedAt: BigInt(planningAsOf),
      },
      create: {
        id: 'singleton',
        snapshotId: created.id,
        pointerVersion: 1,
        updatedAt: BigInt(planningAsOf),
      },
    });

    this.logger.log(
      `Published snapshot ${inputHash.slice(0, 12)} on ${trigger}: ` +
        `${diagnostics.requestsIncluded} requests, ${diagnostics.engineersIncluded} engineers`,
    );

    return {
      published: true,
      inputHash,
      planningAsOf,
      snapshotId: created.id,
    };
  }
}
