import { z } from 'zod';
import { t } from '../i18n';

const challengeSchema = z.object({
  kind: z.literal('window_change_confirmation'),
  requestId: z.string(),
  version: z.number().int(),
  previousStartAt: z.number(),
  previousEndAt: z.number(),
  windowStartAt: z.number(),
  windowEndAt: z.number(),
  confirmation: z.string().min(1),
});
export type WindowConfirmation = z.infer<typeof challengeSchema>;

/** Extracts only server-validated window challenge fields from a failed HTTP response. */
export function windowConfirmationFrom(body: unknown): WindowConfirmation | null {
  const envelope = z.object({ error: z.object({ details: challengeSchema }) }).safeParse(body);
  return envelope.success ? envelope.data.error.details : null;
}

/** Explicit refusal is a skipped step, never a successful resolution of the alert. */
export class WindowChangeDeclined extends Error {
  constructor() {
    super(t('api.windowConfirmation.66fe2ac6e6'));
  }
}

type PendingConfirmation = { change: WindowConfirmation; resolve: (accepted: boolean) => void };
const queue: PendingConfirmation[] = [];
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Subscribes the global dialog to a serial confirmation queue. */
export function subscribeWindowConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      for (const pending of queue.splice(0)) pending.resolve(false);
    }
  };
}

/** Stable external-store snapshot: only the first pending change can be answered. */
export function currentWindowConfirmation(): WindowConfirmation | null {
  return queue[0]?.change ?? null;
}

/** Waits for explicit UI input; no mounted dialog means fail closed. */
export function confirmWindowChange(change: WindowConfirmation): Promise<boolean> {
  if (listeners.size === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    queue.push({ change, resolve });
    notify();
  });
}

/** Resolves exactly the displayed change, preserving other queued callers. */
export function answerWindowConfirmation(accepted: boolean): void {
  queue.shift()?.resolve(accepted);
  notify();
}
