import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time';
import { PrismaService } from '../../persistence';
import { type AiRunEvent, PERSISTED_AI_EVENT_TYPES } from './ai-event.types';
import type { RunHandle } from './run-registry';

/**
 * Plain `Omit` collapses a discriminated union to its common fields, which would erase
 * every event-specific property (`runId`, `messageId`, `toolName`, ...) from the type
 * callers of {@link RunEventBus.emit} are meant to supply. Distributing over the union
 * first keeps each member's own shape intact.
 */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type AiRunEventInput = DistributiveOmit<AiRunEvent, 'seq' | 'at'>;

/**
 * Assigns `seq`, persists what the contract in `ai-event.types.ts` says must be
 * persisted, and multicasts to whoever is listening on this run's `RunHandle`.
 *
 * The sequence counter lives in memory rather than as a database increment on every
 * event: `RunRegistry` already documents that one run is only ever driven by one process,
 * so nothing else can be racing this counter, and a database round trip per
 * `message_delta` would make the SSE stream stutter on every token. Persisted events
 * still update `AiRun.lastEventSeq` in the same write, because that column exists so a
 * resuming client's upper bound is a single row read rather than a scan of
 * `ai_run_events` (see the model's own doc comment in schema.prisma).
 */
@Injectable()
export class RunEventBus {
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async emit(handle: RunHandle, event: AiRunEventInput): Promise<AiRunEvent> {
    const seq = (this.counters.get(handle.runId) ?? 0) + 1;
    this.counters.set(handle.runId, seq);
    const full = { ...event, seq, at: this.clock.nowSeconds() } as AiRunEvent;

    if (PERSISTED_AI_EVENT_TYPES.has(full.type)) {
      await this.prisma.$transaction([
        this.prisma.aiRunEvent.create({
          data: {
            runId: handle.runId,
            seq,
            type: full.type,
            payload: full as object,
            createdAt: BigInt(full.at),
          },
        }),
        this.prisma.aiRun.update({ where: { id: handle.runId }, data: { lastEventSeq: seq } }),
      ]);
    }

    handle.events.next(full);
    return full;
  }

  /** Drops the in-memory counter once a run has produced its terminal event; called by
   *  `AgentRuntimeService` alongside `RunRegistry.remove`. */
  forget(runId: string): void {
    this.counters.delete(runId);
  }
}
