/**
 * Builds a `RouterResult` the way Router Core would return one.
 *
 * Hand-written rather than recorded, because Router Core does not exist yet: this is the
 * contract of context/33 section 8 expressed as data, and the acceptance path is tested
 * against it exactly as it will be against the real thing.
 */

export interface ResultRequestInput {
  readonly requestId: string;
  readonly engineerId: string;
  readonly lat: number;
  readonly lon: number;
  readonly startAt: number;
  readonly durationSec: number;
}

export interface BuildResultOptions {
  readonly resultId: string;
  readonly inputPublicationId?: string;
  readonly inputHash: string;
  readonly contextVersion: string;
  readonly planningAsOf: number;
  readonly assigned?: ResultRequestInput[];
  readonly unassigned?: Array<{ requestId: string; code: string; text: string }>;
  readonly isUsable?: boolean;
  readonly scheduledLunchFor?: string[];
  /** Inserts the scheduled lunch after this route-local assigned item for LIVE tests. */
  readonly lunchAfterAssignedIndex?: number;
  readonly alerts?: Array<{ alertId: string; code: string; requestIds: string[] }>;
  readonly withRoadLeg?: boolean;
}

export function buildRouterResult(options: BuildResultOptions): unknown {
  const assigned = options.assigned ?? [];
  const unassigned = options.unassigned ?? [];

  const byEngineer = new Map<string, ResultRequestInput[]>();
  for (const item of assigned) {
    byEngineer.set(item.engineerId, [...(byEngineer.get(item.engineerId) ?? []), item]);
  }
  for (const engineerId of options.scheduledLunchFor ?? []) {
    if (!byEngineer.has(engineerId)) {
      byEngineer.set(engineerId, []);
    }
  }

  const routes = [...byEngineer.entries()].map(([engineerId, items]) => {
    const withLunch = (options.scheduledLunchFor ?? []).includes(engineerId);
    const stops = items.map((item, index) => ({
      stop_id: `${engineerId}-stop-${index}`,
      sequence: index,
      kind: 'job' as const,
      request_id: item.requestId,
      location: { lat: item.lat, lon: item.lon },
      arrival_at: item.startAt,
      start_at: item.startAt,
      end_at: item.startAt + item.durationSec,
    }));
    if (withLunch) {
      const afterIndex = Math.max(
        -1,
        Math.min(options.lunchAfterAssignedIndex ?? stops.length - 1, stops.length - 1),
      );
      const previous = stops[afterIndex];
      const lunchStart = (previous?.end_at ?? options.planningAsOf) + 600;
      stops.splice(afterIndex + 1, 0, {
        stop_id: `${engineerId}-lunch`,
        sequence: afterIndex + 1,
        kind: 'lunch' as unknown as 'job',
        request_id: null as unknown as string,
        location: { lat: items[0]?.lat ?? 55.75, lon: items[0]?.lon ?? 37.62 },
        arrival_at: lunchStart,
        start_at: lunchStart,
        end_at: lunchStart + 1800,
      });
      stops.forEach((stop, index) => {
        stop.sequence = index;
      });
    }

    return {
      engineer_id: engineerId,
      start_location: { lat: 55.75, lon: 37.62 },
      start_at: stops[0]?.start_at ?? null,
      finish_at: stops.at(-1)?.end_at ?? null,
      stops,
      legs:
        options.withRoadLeg && stops[0]
          ? [
              {
                leg_id: `${engineerId}-leg-0`,
                from_stop_id: null,
                to_stop_id: stops[0].stop_id,
                departure_at: stops[0].arrival_at - 600,
                arrival_at: stops[0].arrival_at,
                travel_time_sec: 600,
                distance_km: 3.5,
                geometry: {
                  points: [{ lat: 55.75, lon: 37.62 }, stops[0].location],
                },
                travel_source: 'route_api',
                traffic_factor: 1.25,
              },
            ]
          : [],
      lunch: withLunch
        ? { status: 'scheduled', stop_id: `${engineerId}-lunch`, reasons: [] }
        : { status: 'disabled', stop_id: null, reasons: [] },
      metrics: {
        distance_km: 12.5,
        travel_time_sec: 1800,
        work_time_sec: items.reduce((total, item) => total + item.durationSec, 0),
        waiting_time_sec: 0,
        lunch_time_sec: withLunch ? 1800 : 0,
        assigned_count: items.length,
      },
      reasons: [
        {
          code: 'CONSTRAINTS_SATISFIED',
          text: 'Skill, transport and window all hold',
          basis: 'constraint_check',
          facts: {},
        },
      ],
    };
  });

  const assignments = [
    ...assigned.map((item) => ({
      request_id: item.requestId,
      status: 'assigned',
      engineer_id: item.engineerId,
      stop_id: `${item.engineerId}-stop-0`,
      reasons: [
        {
          code: 'CONSTRAINTS_SATISFIED',
          text: 'Nearest suitable engineer within the window',
          basis: 'constraint_check',
          facts: { requiredSkill: 'connection' },
        },
      ],
    })),
    ...unassigned.map((item) => ({
      request_id: item.requestId,
      status: 'unassigned',
      engineer_id: null,
      stop_id: null,
      reasons: [
        {
          code: item.code,
          text: item.text,
          // "The search found no variant" is a different claim from "a constraint ruled
          // it out", and the contract keeps them apart (context/33 section 8).
          basis: 'calculation_outcome',
          facts: {},
        },
      ],
    })),
  ];

  const plan = {
    is_usable: options.isUsable ?? true,
    metric_scope: 'snapshot_remaining',
    routes,
    assignments,
    summary: {
      requests_total: assignments.length,
      assigned_count: assigned.length,
      unassigned_count: unassigned.length,
      urgent_total: 0,
      urgent_assigned_count: 0,
      // Counted by assigned work, so an engineer who only has lunch does not count.
      engineers_used: routes.filter((route) => route.metrics.assigned_count > 0).length,
      distance_km: routes.reduce((total, route) => total + route.metrics.distance_km, 0),
      travel_time_sec: routes.reduce((total, route) => total + route.metrics.travel_time_sec, 0),
      work_time_sec: routes.reduce((total, route) => total + route.metrics.work_time_sec, 0),
      waiting_time_sec: 0,
      lunch_time_sec: routes.reduce((total, route) => total + route.metrics.lunch_time_sec, 0),
    },
    alerts: (options.alerts ?? []).map((alert) => ({
      alert_id: alert.alertId,
      code: alert.code,
      severity: 'warning',
      engineer_ids: [],
      request_ids: alert.requestIds,
      reasons: [],
      restore_option: null,
    })),
  };

  return {
    schema_version: '1.0',
    status: 'ready',
    result_id: options.resultId,
    input_publication_id: options.inputPublicationId ?? null,
    input_hash: options.inputHash,
    planning_as_of: options.planningAsOf,
    computed_at: options.planningAsOf + 2,
    router_context_version: options.contextVersion,
    main: plan,
    // The baseline has the same shape and the same snapshot, so the comparison is fair
    // (context/33 section 2).
    baseline: { ...plan, alerts: [] },
    errors: [],
  };
}
