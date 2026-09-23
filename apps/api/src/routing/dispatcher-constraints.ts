import { z } from 'zod';
import type { RouterTaskSnapshot } from './mount-data-eng/snapshot.types';
import type { RouterPlan } from './router-gateway/result.types';

const assignment = z.object({ requestId: z.string().min(1), engineerId: z.string().min(1) });
const order = z.object({
  engineerId: z.string().min(1),
  requestIds: z.array(z.string().min(1)).min(2).max(500),
});

/** Persisted dispatcher intentions; only remaining work is projected to Router. */
export const dispatcherConstraintsSchema = z
  .object({
    assignments: z.array(assignment).max(500),
    orders: z.array(order).max(200),
  })
  .superRefine((value, context) => {
    const owners = new Map(value.assignments.map((row) => [row.requestId, row.engineerId]));
    if (owners.size !== value.assignments.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate pinned request' });
    }
    if (new Set(value.orders.map((row) => row.engineerId)).size !== value.orders.length) {
      context.addIssue({ code: 'custom', message: 'Duplicate pinned engineer order' });
    }
    for (const row of value.orders) {
      if (
        new Set(row.requestIds).size !== row.requestIds.length ||
        row.requestIds.some((requestId) => owners.get(requestId) !== row.engineerId)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Order must name unique jobs pinned to its engineer',
        });
      }
    }
  });

export type DispatcherConstraints = z.infer<typeof dispatcherConstraintsSchema>;

/** Fields independently checked when a Router package reaches the application boundary. */
export const dispatcherSnapshotFactsSchema = z.object({
  requests: z.array(
    z.object({
      request_id: z.string(),
      window_start_at: z.number(),
      window_end_at: z.number(),
      priority: z.enum(['normal', 'urgent']),
      pinned_engineer_id: z.string().optional(),
    }),
  ),
  pinned_orders: z
    .array(z.object({ engineer_id: z.string(), request_ids: z.array(z.string()) }))
    .optional(),
});
export type DispatcherSnapshotFacts = z.infer<typeof dispatcherSnapshotFactsSchema>;

/** A fresh empty value avoids sharing mutable JSON between transactions. */
export function emptyDispatcherConstraints(): DispatcherConstraints {
  return { assignments: [], orders: [] };
}

/** Validate persisted JSON and normalize identity order for stable snapshot hashes. */
export function readDispatcherConstraints(value: unknown): DispatcherConstraints {
  const parsed = dispatcherConstraintsSchema.parse(value ?? emptyDispatcherConstraints());
  return {
    assignments: [...parsed.assignments].sort((a, b) => a.requestId.localeCompare(b.requestId)),
    orders: [...parsed.orders].sort((a, b) => a.engineerId.localeCompare(b.engineerId)),
  };
}

/** Replace the pin projection without reviving executed, reserved, or other-day work. */
export function withDispatcherConstraints(
  snapshot: RouterTaskSnapshot,
  constraints: DispatcherConstraints,
): RouterTaskSnapshot {
  const owners = new Map(constraints.assignments.map((row) => [row.requestId, row.engineerId]));
  const remaining = new Set(snapshot.requests.map((row) => row.request_id));
  const requests = snapshot.requests.map((row) => {
    const { pinned_engineer_id: _previousPin, ...request } = row;
    const engineerId = owners.get(row.request_id);
    return engineerId ? { ...request, pinned_engineer_id: engineerId } : request;
  });
  const orders = constraints.orders
    .map((row) => ({
      engineer_id: row.engineerId,
      request_ids: row.requestIds.filter((requestId) => remaining.has(requestId)),
    }))
    .filter((row) => row.request_ids.length >= 2);
  const { pinned_orders: _previousOrder, ...input } = snapshot;
  return { ...input, requests, ...(orders.length ? { pinned_orders: orders } : {}) };
}

/** Defense at the acceptance boundary: a usable package cannot silently release pins. */
export function dispatcherConstraintConflict(
  snapshot: DispatcherSnapshotFacts,
  plan: RouterPlan,
): string | null {
  const owners = new Map(plan.assignments.map((row) => [row.request_id, row.engineer_id]));
  for (const request of snapshot.requests) {
    if (
      request.pinned_engineer_id &&
      owners.get(request.request_id) !== request.pinned_engineer_id
    ) {
      return `Pinned request ${request.request_id} changed engineer`;
    }
  }
  for (const order of snapshot.pinned_orders ?? []) {
    const route = plan.routes.find((row) => row.engineer_id === order.engineer_id);
    const actual =
      route?.stops.filter((stop) => stop.kind === 'job').map((stop) => stop.request_id) ?? [];
    const positions = order.request_ids.map((requestId) => actual.indexOf(requestId));
    if (
      positions.some(
        (position, index) =>
          position < 0 || (index > 0 && position <= (positions[index - 1] ?? -1)),
      )
    ) {
      return `Pinned order of ${order.engineer_id} changed`;
    }
  }
  return null;
}
