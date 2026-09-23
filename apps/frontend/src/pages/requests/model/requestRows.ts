import type { EngineerView } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';
import { requestStatusTitle } from '@/entities/request';
import type { StatusTone } from '@/shared/ui';

export type RequestSort = 'window' | 'status' | 'engineer' | 'address';

export interface RequestRow {
  id: string;
  /** Short form of the id: the API ships no human-readable request number. */
  number: string;
  addressText: string;
  serviceTitle: string;
  windowStartAt: number;
  windowEndAt: number;
  engineerName: string | null;
  statusTitle: string;
  statusTone: StatusTone;
}

function toneOf(request: RequestView): StatusTone {
  if (request.lifecycle === 'completed') return 'done';
  if (request.lifecycle === 'in_progress') return 'running';
  if (request.assignmentState === 'unassigned') return 'attention';
  return 'neutral';
}

/** Rank used when sorting by status, most demanding of attention first. */
const TONE_RANK: Record<StatusTone, number> = {
  attention: 0,
  running: 1,
  neutral: 2,
  done: 3,
};

/**
 * Joins a request with whoever the applied plan gave it to.
 *
 * The crew comes from the plan's assignments, not from the request: a request
 * carries no engineer of its own, and inventing one from a route would blur the
 * line between what was planned and what the request itself states.
 */
export function buildRequestRows(
  requests: RequestView[],
  plan: PlanView | null,
  engineers: EngineerView[],
): RequestRow[] {
  const engineerById = new Map(engineers.map((engineer) => [engineer.id, engineer.displayName]));
  const assignedTo = new Map(
    (plan?.assignments ?? [])
      .filter((assignment) => assignment.status === 'assigned' && assignment.engineerId)
      .map((assignment) => [assignment.requestId, assignment.engineerId as string]),
  );

  return requests
    .filter((request) => request.lifecycle !== 'cancelled')
    .map((request) => {
      const engineerId = assignedTo.get(request.id);
      return {
        id: request.id,
        number: request.id.slice(0, 8),
        addressText: request.addressText,
        serviceTitle: request.workTypeTitle,
        windowStartAt: request.windowStartAt,
        windowEndAt: request.windowEndAt,
        engineerName: engineerId ? (engineerById.get(engineerId) ?? null) : null,
        statusTitle: requestStatusTitle(request),
        statusTone: toneOf(request),
      };
    });
}

/** Case-insensitive match over the fields the search box promises. */
export function filterRows(rows: RequestRow[], query: string): RequestRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.number.toLowerCase().includes(needle) ||
      row.addressText.toLowerCase().includes(needle) ||
      row.serviceTitle.toLowerCase().includes(needle) ||
      (row.engineerName?.toLowerCase().includes(needle) ?? false),
  );
}

export function sortRows(rows: RequestRow[], sort: RequestSort): RequestRow[] {
  const sorted = [...rows];
  switch (sort) {
    case 'status':
      return sorted.sort(
        (a, b) =>
          TONE_RANK[a.statusTone] - TONE_RANK[b.statusTone] || a.windowStartAt - b.windowStartAt,
      );
    case 'engineer':
      return sorted.sort((a, b) =>
        (a.engineerName ?? 'я').localeCompare(b.engineerName ?? 'я', 'ru'),
      );
    case 'address':
      return sorted.sort((a, b) => a.addressText.localeCompare(b.addressText, 'ru'));
    default:
      return sorted.sort((a, b) => a.windowStartAt - b.windowStartAt);
  }
}
