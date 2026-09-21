import type { EngineerView } from '@/entities/engineer';
import type { PlanView } from '@/entities/plan';

export interface EngineerRow {
  engineerId: string;
  name: string;
  /** Kilometres of the applied route; `null` when the engineer has no route. */
  distanceKm: number | null;
  /** Work still ahead of this crew in the applied plan. */
  assignedCount: number;
  shiftStartAt: number | null;
  shiftEndAt: number | null;
  availability: 'online' | 'offline' | null;
}

/**
 * Joins what the crew is, and what the applied plan still has for it.
 *
 * There is deliberately no "done" count here. The Router plans only the work
 * that remains: a request drops out of the plan the moment it is started or
 * finished, and no dispatcher endpoint says which crew did it. Counting
 * completions from the plan would therefore always report zero — see the note
 * in docs about the missing attribution.
 */
export function buildEngineerRows(engineers: EngineerView[], plan: PlanView | null): EngineerRow[] {
  const routeByEngineer = new Map(plan?.routes.map((route) => [route.engineerId, route]) ?? []);
  const assignedByEngineer = new Map<string, number>();
  for (const assignment of plan?.assignments ?? []) {
    if (assignment.status !== 'assigned' || !assignment.engineerId) continue;
    assignedByEngineer.set(
      assignment.engineerId,
      (assignedByEngineer.get(assignment.engineerId) ?? 0) + 1,
    );
  }

  return engineers.map((engineer) => {
    const route = routeByEngineer.get(engineer.id);
    return {
      engineerId: engineer.id,
      name: engineer.displayName,
      distanceKm: route?.distanceKm ?? null,
      assignedCount: route?.assignedCount ?? assignedByEngineer.get(engineer.id) ?? 0,
      shiftStartAt: engineer.day?.shiftStartAt ?? null,
      shiftEndAt: engineer.day?.shiftEndAt ?? null,
      availability: engineer.day?.availability ?? null,
    };
  });
}
