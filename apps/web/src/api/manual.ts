import { z } from 'zod';
import { requestJson } from './client';
import type { DispatchPlanResponse } from './types';

const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reassign'), requestId: z.string(), engineerId: z.string() }),
  z.object({ kind: z.literal('reorder'), requestIds: z.array(z.string()), engineerId: z.string() }),
]);

/** A single manual gesture, saved against the revision shown in its preview. */
export type ManualChange = z.infer<typeof changeSchema>;
export interface PlanExpectation {
  readonly expectedModeVersion: number;
  readonly expectedPlanRevision: number;
}

/** Capture these versions when opening an editor; never substitute a newer read on save. */
export function manualExpectation(plan: DispatchPlanResponse): PlanExpectation {
  return { expectedModeVersion: plan.modeVersion, expectedPlanRevision: plan.plan?.revision ?? 0 };
}

const previewSchema = z.object({
  sourcePlanRevision: z.number(),
  timingStatus: z.literal('unverified'),
  queues: z.array(z.object({ engineerId: z.string(), requestIds: z.array(z.string()) })),
  warnings: z.array(z.object({ code: z.string(), requestId: z.string(), engineerId: z.string() })),
});
export type ManualPreview = z.infer<typeof previewSchema>;

/** Read-only server preview; it works without an external Router. */
export function previewManualChange(
  token: string,
  change: ManualChange,
  expected: PlanExpectation,
) {
  return requestJson('/api/v1/dispatch/plan/manual-preview', previewSchema, token, {
    method: 'POST',
    body: JSON.stringify({ ...change, ...expected, operationId: crypto.randomUUID() }),
  });
}

/** One stable operation id belongs to one gesture, including retries after lost responses. */
export function applyManualChange(
  token: string,
  change: ManualChange,
  expected: PlanExpectation,
  operationId: string,
) {
  return requestJson(`/api/v1/dispatch/plan/${change.kind}`, z.unknown(), token, {
    method: 'POST',
    body: JSON.stringify({ ...change, ...expected, operationId }),
  });
}

const historySchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      at: z.number(),
      actorId: z.string(),
      action: z.string(),
      details: z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        reason: z.string().nullable().optional(),
        sourcePlanRevision: z.number().nullable().optional(),
        planRevision: z.number().optional(),
        change: changeSchema.optional(),
      }),
    }),
  ),
});
export type ManualHistory = z.infer<typeof historySchema>['entries'];

/** Persistent transition and edit evidence, independent of this browser's event list. */
export function fetchManualHistory(token: string) {
  return requestJson('/api/v1/dispatch/plan/manual-history', historySchema, token);
}
