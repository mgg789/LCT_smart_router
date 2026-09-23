import type { EngineerView } from '@/entities/engineer';
import type { CrewTally, DispatchLiveView } from '@/entities/live';
import { crewTally } from '@/entities/live';
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
  /** «выполнено N/M» — `null` when the LIVE day does not know this crew. */
  tally: CrewTally | null;
}

/**
 * Joins what the crew is, what the applied plan still has for it, and what the
 * LIVE day says it has already done.
 *
 * The plan alone cannot say what is behind a crew: a request leaves it the
 * moment it is started or finished. The LIVE workday keeps that tally per crew,
 * so the done count comes from there and the plan supplies only what is ahead.
 */
export function buildEngineerRows(
  engineers: EngineerView[],
  plan: PlanView | null,
  live: DispatchLiveView | null = null,
): EngineerRow[] {
  const liveById = new Map(live?.engineers.map((state) => [state.id, state]) ?? []);
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
      tally: crewTally(
        liveById.get(engineer.id),
        (route?.stops ?? []).flatMap((stop) =>
          stop.kind === 'job' && stop.requestId ? [stop.requestId] : [],
        ),
      ),
    };
  });
}
