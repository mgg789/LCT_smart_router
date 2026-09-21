/** AUTO applies router results; MANUAL leaves the plan to the dispatcher. */
export type DispatchMode = 'auto' | 'manual';

/**
 * Answer of `GET /dispatch/plan`.
 *
 * Only the control fields are read today — the day screen will exercise the rest.
 * Shapes follow docs/frontend-api.md §6.5; the top level is confirmed against the
 * running System Layer.
 */
export interface DispatchStateView {
  mode: DispatchMode;
  modeVersion: number;
  /** `null` is an honest empty state: no plan has been applied yet, not an error. */
  plan: PlanView | null;
  appliedResult: ResultRef | null;
  lastResult: LastResultRef | null;
}

export interface PlanView {
  revision: number;
  origin: 'auto' | 'manual';
  /** Unix seconds; show it next to the plan while a rebuild is running. */
  planAsOf: number;
  appliedAt: number;
  routes: PlanRouteView[];
  assignments: PlanAssignmentView[];
}

export interface PlanRouteView {
  engineerId: string;
  startLat: number;
  startLon: number;
  startAt: number;
  finishAt: number;
  distanceKm: number;
  travelTimeSec: number;
  workTimeSec: number;
  waitingTimeSec: number;
  lunchTimeSec: number;
  assignedCount: number;
  lunchStatus: string;
  /**
   * One movement per visit, in the route's order. Absent on plans stored before
   * the contract carried legs, hence optional.
   */
  legs?: PlanRouteLegView[];
  stops: PlanStopView[];
}

/** Where a leg's travel time came from; only road sources carry a road shape. */
export type TravelSource = 'approximate' | 'road_matrix' | 'route_api' | 'traffic_api';

/** One planned movement between two stops (docs/frontend-api.md §6.5). */
export interface PlanRouteLegView {
  legId: string;
  fromStopId: string | null;
  toStopId: string;
  departureAt: number;
  /** Equals the `arrivalAt` of the stop the leg ends at. */
  arrivalAt: number;
  travelTimeSec: number;
  distanceKm: number;
  /** The road itself, when Router — or a map provider — had one; otherwise `null`. */
  geometry: { points: Array<{ lat: number; lon: number }> } | null;
  travelSource: TravelSource;
  trafficFactor: number;
  geometryProvider?: 'twogis' | 'yandex';
}

export interface PlanStopView {
  sequence: number;
  kind: 'job' | 'lunch' | 'wait';
  requestId: string | null;
  lat: number;
  lon: number;
  /** Planned values, never facts: arrivalAt ≤ startAt ≤ endAt. */
  arrivalAt: number;
  startAt: number;
  endAt: number;
}

export interface PlanAssignmentView {
  requestId: string;
  status: 'assigned' | 'unassigned' | 'pending';
  engineerId: string | null;
  reasons: AssignmentReason[];
}

export interface AssignmentReason {
  code: string;
  text: string;
  /** A checked constraint, or the outcome of a limited search — not the same thing. */
  basis: 'constraint_check' | 'calculation_outcome';
  facts?: Record<string, unknown>;
}

export interface ResultRef {
  resultId: string;
  inputHash: string;
  routerContextVersion: string;
}

export interface LastResultRef extends ResultRef {
  accepted: boolean;
  rejectionCode: string | null;
  receivedAt: number;
}
