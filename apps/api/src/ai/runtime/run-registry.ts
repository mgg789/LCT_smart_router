import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { AiRunEvent } from './ai-event.types';

/**
 * The live half of a run: an `AbortController` the loop and every provider call listen
 * to, and a `Subject` the SSE transport multicasts from.
 *
 * **This registry is single-instance only.** It lives in process memory, so a restart or
 * a second replica loses it entirely -- a run's true, durable status is `AiRun.state`,
 * and `AiRun.stopRequestedAt` is what a stop survives a restart through. The registry
 * exists purely to make an *in-progress* run interruptible and streamable without a
 * database round trip on every token; nothing here is a source of truth for anything
 * that must outlive this process. `AgentRuntimeService`'s startup sweep is what a
 * reconnecting client actually depends on for a truthful answer after a crash.
 */
export interface RunHandle {
  readonly runId: string;
  readonly abort: AbortController;
  readonly events: Subject<AiRunEvent>;
  /** Reason recorded by the most recent `StopService.requestStop` call in this process,
   *  read by the loop once it observes the abort signal. */
  stopReason?: 'user' | 'handover' | 'budget' | 'shutdown';
}

@Injectable()
export class RunRegistry {
  private readonly runs = new Map<string, RunHandle>();

  create(runId: string): RunHandle {
    const handle: RunHandle = {
      runId,
      abort: new AbortController(),
      events: new Subject<AiRunEvent>(),
    };
    this.runs.set(runId, handle);
    return handle;
  }

  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }

  /** Called once a run reaches a terminal event: closes the multicast subject so a
   *  connected SSE handler completes instead of hanging, and drops the handle. */
  remove(runId: string): void {
    const handle = this.runs.get(runId);
    if (!handle) {
      return;
    }
    handle.events.complete();
    this.runs.delete(runId);
  }
}
