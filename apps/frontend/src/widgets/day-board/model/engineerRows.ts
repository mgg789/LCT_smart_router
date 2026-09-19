import type { EngineerView } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';
import type { RequestView } from '@/entities/request';

export interface EngineerRow {
  engineerId: string;
  name: string;
  /** Kilometres of the applied route; `null` when the engineer has no route. */
  distanceKm: number | null;
  assignedCount: number;
  doneCount: number;
  shiftStartAt: number | null;
  shiftEndAt: number | null;
  availability: 'online' | 'offline' | null;
}

/**
 * Joins what the three endpoints each know: the crew, its route in the applied
 * plan, and how much of that route the execution facts say is finished.
 *
 * Progress comes from the requests' lifecycle, not from the plan — the plan says
 * what should happen, the requests say what did.
 */
export function buildEngineerRows(
  engineers: EngineerView[],
  plan: PlanView | null,
  requests: RequestView[],
): EngineerRow[] {
  const routeByEngineer = new Map(plan?.routes.map((route) => [route.engineerId, route]) ?? []);
  const lifecycleById = new Map(requests.map((request) => [request.id, request.lifecycle]));

  const doneByEngineer = new Map<string, number>();
  const assignedByEngineer = new Map<string, number>();
  for (const assignment of plan?.assignments ?? []) {
    if (assignment.status !== 'assigned' || !assignment.engineerId) continue;
    assignedByEngineer.set(
      assignment.engineerId,
      (assignedByEngineer.get(assignment.engineerId) ?? 0) + 1,
    );
    if (lifecycleById.get(assignment.requestId) === 'completed') {
      doneByEngineer.set(
        assignment.engineerId,
        (doneByEngineer.get(assignment.engineerId) ?? 0) + 1,
      );
    }
  }

  return engineers.map((engineer) => {
    const route = routeByEngineer.get(engineer.id);
    return {
      engineerId: engineer.id,
      name: engineer.displayName,
      distanceKm: route?.distanceKm ?? null,
      assignedCount: route?.assignedCount ?? assignedByEngineer.get(engineer.id) ?? 0,
      doneCount: doneByEngineer.get(engineer.id) ?? 0,
      shiftStartAt: engineer.day?.shiftStartAt ?? null,
      shiftEndAt: engineer.day?.shiftEndAt ?? null,
      availability: engineer.day?.availability ?? null,
    };
  });
}
