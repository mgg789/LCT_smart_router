import { Injectable } from '@nestjs/common';

export type ActionDecision = 'allow' | 'reject';
export type ActionWaitResult = ActionDecision | 'stopped' | 'expired';

/**
 * Holds a fix-mode tool call open while the dispatcher answers a risky card.
 *
 * The model stays inside the tool until `resolve` runs from confirm or cancel.
 * A stop or the card's own deadline unblocks the call so the run cannot sit forever.
 */
@Injectable()
export class ActionDecisionGate {
  private readonly waiters = new Map<string, (decision: ActionDecision) => void>();

  wait(operationId: string, signal: AbortSignal, timeoutMs: number): Promise<ActionWaitResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ActionWaitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(operationId);
        resolve(result);
      };
      const onAbort = () => finish('stopped');
      const timer = setTimeout(() => finish('expired'), timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(operationId, (decision) => finish(decision));
      if (signal.aborted) finish('stopped');
    });
  }

  /** Wakes the tool that is still inside this card. A missing waiter is a no-op. */
  resolve(operationId: string, decision: ActionDecision): void {
    this.waiters.get(operationId)?.(decision);
  }
}
