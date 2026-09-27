import { z } from 'zod';
import type { Tx } from '../../persistence';

const prioritySchema = z.object({ requestId: z.string(), version: z.string() });

/** One dispatcher-selected request per workday; a revision guards replacement confirmation. */
export async function readRequestPriority(tx: Pick<Tx, 'appState'>, workDate: string) {
  const row = await tx.appState.findUnique({ where: { key: requestPriorityKey(workDate) } });
  return prioritySchema.safeParse(row?.value).data ?? null;
}

/** Date scoping prevents a previous day's override from affecting a new imported day. */
export function requestPriorityKey(workDate: string): string {
  return `policy.request-priority:${workDate}`;
}
