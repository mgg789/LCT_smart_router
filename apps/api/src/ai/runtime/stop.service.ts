import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/time';
import { PrismaService } from '../../persistence';
import type { AiStopReason } from './ai-event.types';
import { RunRegistry } from './run-registry';

/** Thrown by {@link StopService.checkpoint} to unwind the run loop the moment a stop is
 *  observed. Caught in exactly one place, `AgentRuntimeService`'s loop, which turns it
 *  into a `stopped` event rather than letting it become an unhandled rejection. */
export class RunStoppedSignal extends Error {
  constructor(readonly reason: AiStopReason) {
    super(`Run stopped (${reason})`);
    this.name = 'RunStoppedSignal';
  }
}

/**
 * Durable stop flag plus the in-process abort that makes an already-running provider
 * call or tool actually unwind.
 *
 * The database write is what a stop survives past this process: `AiRun.stopRequestedAt`
 * is set first, so even if the abort never reaches a live `RunHandle` (the request landed
 * on a different process, or arrived after the run already finished) the fact that a stop
 * was asked for is never lost. `checkpoint()` is what the loop actually reacts to, and it
 * only ever looks at the in-process signal -- the database flag matters to
 * `AgentRuntimeService`'s startup sweep, not to a live loop, which already has the
 * `AbortSignal` from the same `RunHandle` the stop request aborted.
 */
@Injectable()
export class StopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: RunRegistry,
    private readonly clock: Clock,
  ) {}

  async requestStop(runId: string, reason: AiStopReason = 'user'): Promise<void> {
    const now = this.clock.nowSeconds();
    await this.prisma.aiRun.updateMany({
      where: { id: runId, state: { in: ['running', 'stopping'] } },
      data: { stopRequestedAt: BigInt(now), state: 'stopping' },
    });
    const handle = this.registry.get(runId);
    if (handle) {
      handle.stopReason = reason;
      handle.abort.abort();
    }
  }

  /** Called by the loop before every provider call and every tool dispatch. Throws
   *  `RunStoppedSignal` instead of returning a boolean so a forgetful call site fails
   *  loudly (an uncaught throw) rather than silently continuing a run someone stopped. */
  checkpoint(runId: string): void {
    const handle = this.registry.get(runId);
    if (handle?.abort.signal.aborted) {
      throw new RunStoppedSignal(handle.stopReason ?? 'user');
    }
  }
}
