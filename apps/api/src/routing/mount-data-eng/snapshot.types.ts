/**
 * `RouterTaskSnapshot` — the published input sector.
 *
 * The external shape is fixed by context/33 section 5. These types are the System Layer's
 * side of that contract; Router Core has the same structure on its side, and the two must
 * serialize to identical bytes (see `common/json/canonical-json.ts`).
 *
 * What is deliberately *not* here matters as much as what is: no problem text, no names,
 * no email addresses, no execution history, no ETA, no road matrix and no internal
 * tolerance. The map and the technical context are Router's own resources, connected
 * separately (context/33 section 3).
 */

/** Integer Unix seconds. */
export type UnixSeconds = number;

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export type SkillCode = 'local' | 'connection' | 'emergency';
export type TransportCode = 'car' | 'walk' | 'bike' | 'transit';
export type PriorityCode = 'normal' | 'urgent';

export interface SnapshotRequest {
  readonly request_id: string;
  /** Order of arrival. The baseline iterates in it, so it is not a read order. */
  readonly arrival_order: number;
  readonly location: GeoPoint;
  readonly service_duration_sec: number;
  /** Window for the *start* of the work, not for its end. */
  readonly window_start_at: UnixSeconds;
  readonly window_end_at: UnixSeconds;
  readonly priority: PriorityCode;
  readonly required_skill: SkillCode;
  /** `null` means the request places no transport restriction. */
  readonly required_transport: TransportCode | null;
}

export interface SnapshotLunch {
  readonly enabled: boolean;
  readonly duration_sec: number | null;
  readonly window_start_at: UnixSeconds | null;
  readonly window_end_at: UnixSeconds | null;
  /** A one-off requirement after the dispatcher's explicit decision. */
  readonly required: boolean;
}

export interface SnapshotEngineer {
  readonly engineer_id: string;
  /** The baseline picks the first suitable engineer in this order. */
  readonly input_order: number;
  readonly skills: SkillCode[];
  readonly transport_type: TransportCode;
  readonly shift_start_at: UnixSeconds;
  readonly shift_end_at: UnixSeconds;
  /** Where the remaining route continues from. Chosen by sys, not by Router. */
  readonly start_location: GeoPoint;
  /**
   * Not before this moment can the route continue *from `start_location`*.
   *
   * May be a forecast rather than a confirmed completion. `null` is a real "not
   * prepared": it does not mean "free now", and the conservative reading is that no new
   * work is assigned until it is known (context/33 section 9).
   */
  readonly available_from: UnixSeconds | null;
  /** When the position used for the start was observed; `null` if it came from a profile. */
  readonly position_observed_at: UnixSeconds | null;
  /** Working availability, not a network state. */
  readonly availability: 'online' | 'offline';
  /** Forecast return from a technical stop; usually `null` while online. */
  readonly expected_online_at: UnixSeconds | null;
  /** The single lunch of the day has been used. Router schedules no second one. */
  readonly lunch_taken: boolean;
  readonly lunch: SnapshotLunch;
}

export interface SnapshotPolicy {
  readonly policy_id: string;
  readonly parameters: Record<string, string | number | boolean>;
}

export interface RouterTaskSnapshot {
  readonly schema_version: string;
  /** Moment of this publication of changed data. It does not tick on its own. */
  readonly planning_as_of: UnixSeconds;
  readonly horizon_start_at: UnixSeconds;
  readonly horizon_end_at: UnixSeconds;
  /** Only work available for new distribution. */
  readonly requests: SnapshotRequest[];
  readonly engineers: SnapshotEngineer[];
  readonly policy: SnapshotPolicy;
}

export const SNAPSHOT_SCHEMA_VERSION = '1.0';

/**
 * What the projection had to leave out.
 *
 * Stored beside the snapshot rather than inside it: diagnostics are not part of the task
 * and must not change its hash. They exist so that a request missing from the plan is
 * visibly excluded and counted, instead of silently disappearing.
 */
export interface SnapshotDiagnostics {
  readonly requestsIncluded: number;
  readonly engineersIncluded: number;
  /** Submitted work with no coordinates yet; coordinates are never invented. */
  readonly requestsWithoutLocation: number;
  /** Work whose window lies entirely outside the horizon of this task. */
  readonly requestsOutsideHorizon: number;
  /** Engineers with no usable start point, so no route could begin. */
  readonly engineersWithoutStartLocation: number;
  /** Engineers whose working day exists but has no shift set yet. */
  readonly engineersWithoutShift: number;
  /** Engineers with no working day for this horizon. */
  readonly engineersWithoutWorkday: number;
}
