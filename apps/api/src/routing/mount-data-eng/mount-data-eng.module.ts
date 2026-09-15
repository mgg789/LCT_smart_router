import { Global, Module } from '@nestjs/common';
import { SnapshotBuilder } from './snapshot.builder';
import { SnapshotPublisher } from './snapshot.publisher';

/**
 * `mount-data-eng` of context/36 section 2: preparing and publishing the whole current
 * projection into the special sector.
 *
 * Global because orchestrator handlers publish from inside their own transaction; the
 * publication is part of the business change, not a separate job that could be lost.
 */
@Global()
@Module({
  providers: [SnapshotBuilder, SnapshotPublisher],
  exports: [SnapshotBuilder, SnapshotPublisher],
})
export class MountDataEngModule {}
