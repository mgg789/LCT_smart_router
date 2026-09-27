import { z } from 'zod';
import type { Tx } from '../../persistence';

export const MANUAL_STATE_KEY = 'manual.session';
export const manualDecisionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['assignment', 'window', 'lunch', 'shift']),
  targetId: z.string().min(1),
  priority: z.number().int().nonnegative(),
  engineerId: z.string().min(1).nullable().optional(),
  startAt: z.number().int().nonnegative().optional(),
  endAt: z.number().int().nonnegative().optional(),
});
export type ManualDecision = z.infer<typeof manualDecisionSchema>;
export const manualStateSchema = z.object({
  version: z.number().int().nonnegative(),
  workDate: z.string().nullable(),
  reason: z.string().nullable(),
  decisions: z.array(manualDecisionSchema),
  acknowledgedConflicts: z.array(z.string()).default([]),
  resolution: z
    .object({
      acceptedIds: z.array(z.string()),
      rejectedIds: z.array(z.string()),
      conflictIds: z.array(z.string()),
      inputHash: z.string(),
    })
    .nullable(),
});
export type ManualState = z.infer<typeof manualStateSchema>;

/** Typed durable manual intents; original request and shift records remain unchanged. */
export async function readManualState(tx: Tx): Promise<ManualState> {
  const row = await tx.appState.findUnique({ where: { key: MANUAL_STATE_KEY } });
  return row
    ? manualStateSchema.parse(row.value)
    : {
        version: 0,
        workDate: null,
        reason: null,
        decisions: [],
        acknowledgedConflicts: [],
        resolution: null,
      };
}

/** Caller holds the control-state lock, also used by result acceptance. */
export async function writeManualState(tx: Tx, state: ManualState, now: number): Promise<void> {
  await tx.appState.upsert({
    where: { key: MANUAL_STATE_KEY },
    create: { key: MANUAL_STATE_KEY, value: state, updatedAt: BigInt(now) },
    update: { value: state, updatedAt: BigInt(now) },
  });
}

/** New conflict participants require dispatcher review; acknowledged constraints may be skipped. */
export function manualNeedsReview(state: ManualState): boolean {
  return Boolean(
    state.resolution?.rejectedIds.length &&
      state.resolution.conflictIds.some((id) => !state.acknowledgedConflicts.includes(id)),
  );
}

/** Public projection does not expose internal conflict acknowledgement state. */
export function manualStateView(state: ManualState) {
  const { acknowledgedConflicts: _ack, ...view } = state;
  return { ...view, needsReview: manualNeedsReview(state) };
}
