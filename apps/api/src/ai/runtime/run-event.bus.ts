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

  /**
   * Persists an event for a run this process is not driving -- there is no `RunHandle`
   * to multicast on, because `AiOperationService.confirm`/`cancel`/`expire` react to a
   * prepared operation strictly after the run that prepared it already produced its own
   * `run_finished` (a separate later HTTP request, not a continuation of the run loop).
   *
   * The sequence number therefore cannot come from {@link emit}'s in-memory counter --
   * nothing guarantees this process is the one that drove the run, or that the counter
   * was ever populated here -- so it is advanced atomically in the database instead, the
   * same `UPDATE ... RETURNING` shape `budget.service.ts` uses for its own reservation.
   */
  async emitForRun(runId: string, event: AiRunEventInput): Promise<AiRunEvent | null> {
    const now = this.clock.nowSeconds();
    const rows = await this.prisma.$queryRaw<Array<{ last_event_seq: number }>>`
      UPDATE ai_runs SET last_event_seq = last_event_seq + 1 WHERE id = ${runId}
      RETURNING last_event_seq
    `;
    const seq = rows[0]?.last_event_seq;
    if (seq === undefined) {
      // The run row is gone (its conversation was deleted); there is nothing left to
      // attach this event to. Not the caller's fault, so this is a no-op, not a throw.
      return null;
    }
    const full = { ...event, seq, at: now } as AiRunEvent;
    if (PERSISTED_AI_EVENT_TYPES.has(full.type)) {
      await this.prisma.aiRunEvent.create({
        data: { runId, seq, type: full.type, payload: full as object },
      });
    }
    return full;
  }
}
