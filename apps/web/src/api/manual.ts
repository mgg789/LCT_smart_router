import { z } from 'zod';
import { requestJson } from './client';

const decision = z.object({
  id: z.string(),
  kind: z.enum(['assignment', 'window', 'lunch', 'shift']),
  targetId: z.string(),
  priority: z.number(),
  engineerId: z.string().nullable().optional(),
  startAt: z.number().optional(),
  endAt: z.number().optional(),
});
const state = z.object({
  version: z.number(),
  reason: z.string().nullable(),
  decisions: z.array(decision),
  resolution: z
    .object({
      acceptedIds: z.array(z.string()),
      rejectedIds: z.array(z.string()),
      conflictIds: z.array(z.string()),
      inputHash: z.string(),
    })
    .nullable(),
  needsReview: z.boolean(),
});
export type ManualState = z.infer<typeof state>;
export type ManualDecisionInput = Omit<z.infer<typeof decision>, 'id' | 'priority'>;
/** Read the versioned manual constraints and latest solver conflict resolution. */
export function loadManualState(token: string): Promise<ManualState> {
  return requestJson('/api/v1/dispatch/manual', state, token);
}
/** Save one explicit decision; the server validates live facts and window consent. */
export function saveManualDecision(
  token: string,
  expectedVersion: number,
  input: ManualDecisionInput,
): Promise<ManualState> {
  return requestJson('/api/v1/dispatch/manual/decisions', state, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion, ...input }),
  });
}
/** Order all decisions from strongest to weakest after a conflict. */
export function saveManualPriorities(
  token: string,
  expectedVersion: number,
  decisionIds: string[],
): Promise<ManualState> {
  return requestJson('/api/v1/dispatch/manual/priorities', state, token, {
    method: 'POST',
    body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion, decisionIds }),
  });
}
/** Remove a decision without altering historical execution facts. */
export function deleteManualDecision(
  token: string,
  expectedVersion: number,
  id: string,
): Promise<ManualState> {
  return requestJson(`/api/v1/dispatch/manual/decisions/${encodeURIComponent(id)}`, state, token, {
    method: 'DELETE',
    body: JSON.stringify({ operationId: crypto.randomUUID(), expectedVersion }),
  });
}
