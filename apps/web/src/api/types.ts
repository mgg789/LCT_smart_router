/**
 * Dispatcher-facing view types.
 *
 * These mirror `apps/api` plan/request/engineer views so the dashboard can later
 * swap the fixture for `GET /api/v1/dispatch/*` without rewriting the screen.
 * Absolute times are Unix-epoch seconds; local formatting stays in the UI.
 */

export type PolicyId = 'compact' | 'fast' | 'sla' | 'balanced' | 'eco' | 'covering';
export type StrategyId = PolicyId | 'baseline';
export type EquipmentType = 'router' | 'set_top_box' | 'smart_speaker';

export interface EquipmentStock {
  readonly router: number;
  readonly setTopBox: number;
  readonly smartSpeaker: number;
}

export interface PolicySpec {
  readonly policyId: PolicyId;
  readonly title: string;
  readonly description: string;
  readonly isDefault: boolean;
}

export interface RequestView {
  readonly id: string;
  readonly version: number;
  readonly lifecycle: 'draft' | 'submitted' | 'in_progress' | 'completed' | 'cancelled';
  readonly assignmentState: 'pending' | 'unassigned' | 'assigned' | 'in_progress' | 'done';
  readonly addressText: string;
  readonly region: string | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly needsGeocoding: boolean;
  readonly geocodeQuality: string | null;
  readonly requiredEquipment: EquipmentType | null;
  readonly workType: string | null;
  readonly workTypeTitle: string | null;
  readonly requiredSkill: string;
  readonly normProfileCode?: string;
  readonly normativeTravelDurationSec?: number;
  readonly technicalDurationSec?: number;
  readonly documentationDurationSec?: number;
  readonly serviceDurationSec: number;
  readonly actualDurationSec?: number | null;
  readonly durationVarianceSec?: number | null;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly priority: 'normal' | 'urgent';
  readonly contactName: string | null;
  readonly problemText: string | null;
  readonly createdAt: number;
  readonly submittedAt: number | null;
  readonly startedAt: number | null;
  readonly expectedCompletionAt?: number | null;
  readonly continuationAvailableAt?: number | null;
  readonly overrunDetectedAt?: number | null;
  /** Server-derived start inferred from an untouched plan; it is not an engineer confirmation. */
  readonly assumedStartedAt?: number | null;
  /** Server-derived completion inferred from an untouched plan; it is not an engineer confirmation. */
  readonly assumedCompletedAt?: number | null;
  readonly completedAt: number | null;
  readonly cancelledAt: number | null;
}

export interface EngineerView {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly inputOrder: number;
  readonly skills: string[];
  readonly transportType: 'car' | 'walk' | 'bike' | 'transit';
  readonly region: string | null;
  readonly homeLat: number | null;
  readonly homeLon: number | null;
  readonly hasAccount: boolean;
  /** The login address, when the profile has one linked; null on imported brigades. */
  readonly email: string | null;
}

/** Fields collected by the compact dispatcher request form. */
export interface CreateDispatchRequestInput {
  readonly workType: string;
  readonly addressText: string;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly lat?: number | null;
  readonly lon?: number | null;
  readonly contactName?: string;
  readonly clientEmail?: string;
}

/** Dispatcher-owned clocks, alert timers and map-key presence. Secrets are never listed. */
export interface DispatcherSettingsView {
  readonly dayStartMin: number;
  readonly dayEndMin: number;
  readonly noShowSec: number;
  readonly overdueSec: number;
  readonly timeRiskSec: number;
  readonly repeatAfterSec: number;
  readonly twogisApiKeySet: boolean;
  readonly twogisApiKeyLast4: string | null;
  readonly yandexApiKeySet: boolean;
  readonly yandexApiKeyLast4: string | null;
}

export interface DispatcherSettingsPatch {
  readonly dayStartMin?: number;
  readonly dayEndMin?: number;
  readonly noShowSec?: number;
  readonly overdueSec?: number;
  readonly timeRiskSec?: number;
  readonly repeatAfterSec?: number;
  readonly twogisApiKey?: string | null;
  readonly yandexApiKey?: string | null;
}

export interface GeocodeHit {
  readonly displayName: string;
  readonly lat: number;
  readonly lon: number;
}

export interface MapProviderStatus {
  readonly provider: 'twogis' | 'yandex';
  readonly configured: boolean;
  readonly ok: boolean | null;
  readonly message: string;
}

export interface MapProvidersStatus {
  readonly active: 'twogis' | 'yandex' | 'none';
  readonly twogis: MapProviderStatus;
  readonly yandex: MapProviderStatus;
}

/** A routing profile can be created before a login email is known. */
export interface CreateDispatchEngineerInput {
  readonly displayName: string;
  readonly skills: Array<'local' | 'connection' | 'emergency'>;
  readonly transportType: 'car' | 'walk' | 'bike' | 'transit';
  readonly region: string;
  readonly email: string | null;
  readonly homeLat?: number | null;
  readonly homeLon?: number | null;
}

export interface EngineerDayView {
  /** Day-specific exemption from attendance alerts, independent of login access. */
  readonly attendanceOptOut?: boolean;
  readonly lastAttendanceAt?: number | null;
  readonly engineerId: string;
  readonly workDate: string;
  readonly version: number;
  readonly shiftStartAt: number;
  readonly shiftEndAt: number;
  readonly availability: 'online' | 'offline' | 'technical_break';
  readonly expectedOnlineAt: number | null;
  readonly equipmentStock: EquipmentStock;
  readonly equipmentIssuedAt: number | null;
  readonly lunch: {
    readonly enabled: boolean;
    readonly durationSec: number | null;
    readonly windowStartAt: number | null;
    readonly windowEndAt: number | null;
    readonly required: boolean;
    readonly taken: boolean;
    readonly startedAt: number | null;
  };
}

export interface PlanStopView {
  readonly sequence: number;
  readonly kind: 'job' | 'lunch' | 'wait' | 'start';
  readonly requestId: string | null;
  readonly lat: number;
  readonly lon: number;
  readonly arrivalAt: number;
  readonly startAt: number;
  readonly endAt: number;
}

export interface PlanRouteView {
  readonly engineerId: string;
  readonly startLat: number;
  readonly startLon: number;
  readonly startAt: number | null;
  readonly finishAt: number | null;
  readonly distanceKm: number;
  readonly travelTimeSec: number;
  readonly workTimeSec: number;
  readonly waitingTimeSec: number;
  readonly lunchTimeSec: number;
  readonly assignedCount: number;
  readonly lunchStatus:
    | 'none'
    | 'planned'
    | 'taken'
    | 'skipped'
    | 'disabled'
    | 'already_taken'
    | 'scheduled'
    | 'skipped_for_work'
    | 'not_scheduled'
    | 'required_conflict';
  readonly stops: PlanStopView[];
  readonly legs: PlanLegView[];
}

export type TravelSource = 'approximate' | 'road_matrix' | 'route_api' | 'traffic_api';

export interface PlanLegView {
  readonly legId: string;
  readonly fromStopId: string | null;
  readonly toStopId: string;
  readonly departureAt: number;
  readonly arrivalAt: number;
  readonly travelTimeSec: number;
  readonly distanceKm: number;
  readonly travelSource: TravelSource;
  /** Present when sys replaced Router geometry with a map-provider polyline. */
  readonly geometryProvider?: 'twogis' | 'yandex';
  /** Forecast/provider multiplier already included in travelTimeSec. */
  readonly trafficFactor: number;
  /** Ordered WGS84 points returned by the routing provider. */
  readonly geometry: {
    readonly points: ReadonlyArray<{ readonly lat: number; readonly lon: number }>;
  } | null;
}

export interface ReasonFactor {
  readonly code: string;
  readonly ok?: boolean;
  readonly value?: number;
  readonly detail: string;
  readonly basis?: string;
  readonly facts?: Readonly<Record<string, unknown>>;
}

export interface ReasonAlternative {
  readonly engineerId: string;
  readonly blocked: boolean;
  readonly costDeltaMin?: number;
  readonly whyNot: string;
}

export interface AssignmentReasons {
  readonly assignment?: {
    readonly chosen: string | null;
    readonly factors: ReasonFactor[];
    readonly alternatives: ReasonAlternative[];
  };
  readonly sequence?: Array<{
    readonly swapWith: string;
    readonly costDeltaMin: number;
    readonly why: string;
  }>;
}

export interface PlanAssignmentView {
  readonly requestId: string;
  readonly status: 'assigned' | 'unassigned' | 'in_progress' | 'done';
  readonly engineerId: string | null;
  readonly reasons: AssignmentReasons;
}

export interface PlanView {
  readonly revision: number;
  readonly origin: 'auto' | 'manual';
  readonly planAsOf: number;
  readonly appliedAt: number;
  readonly routes: PlanRouteView[];
  readonly assignments: PlanAssignmentView[];
}

export interface AlertView {
  readonly id: string;
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly engineerIds: string[];
  readonly requestIds: string[];
  readonly reasons: string[];
  readonly restoreOption: string | { engineer_id: string; reject_request_ids: string[] } | null;
  readonly createdAt: number;
  readonly seenAt: number | null;
  readonly resolvedAt: number | null;
  /** Optional only for saved snapshots recorded before the alert lifecycle existed. */
  readonly kind?: 'alert' | 'notice';
  readonly actions?: string[];
  readonly workDate?: string | null;
  readonly resolutionAction?: string | null;
  readonly resolutionReason?: string | null;
  readonly resolutionDelaySec?: number | null;
}

/** A dispatcher decision; absolute window bounds use Unix seconds. */
export interface AlertResolutionInput {
  readonly operationId: string;
  readonly action: string;
  readonly reason?: string;
  readonly minutes?: number;
  readonly windowStartAt?: number;
  readonly windowEndAt?: number;
  readonly engineerId?: string;
}

/** Persisted dispatcher close state, checked against all open alerts on the server. */
export interface DispatchShiftView {
  readonly workDate: string;
  readonly closedAt: number | null;
  readonly unresolvedCount: number;
}

export interface DispatchPlanResponse {
  readonly mode: 'auto' | 'manual';
  readonly modeVersion: number;
  readonly plan: PlanView | null;
  readonly appliedResult: {
    readonly resultId: string;
    readonly inputHash: string;
    readonly routerContextVersion: string;
  } | null;
  readonly lastResult: {
    readonly resultId: string;
    readonly inputHash: string;
    readonly routerContextVersion: string;
    readonly accepted: boolean;
    readonly rejectionCode: string | null;
    readonly receivedAt: number;
  } | null;
}

export interface DashboardSnapshot {
  readonly workDate: string;
  readonly timeZone: 'Europe/Moscow';
  readonly nowAt: number;
  readonly policyId: PolicyId;
  readonly lunchesEnabled: boolean;
  /** Full Router-owned settings when the snapshot came from the live API. */
  readonly routerSettings?: RouterTechnicalSettings;
  readonly routerContextVersion: string;
  readonly policies: readonly PolicySpec[];
  readonly engineers: Array<EngineerView & { day: EngineerDayView | null }>;
  readonly requests: RequestView[];
  readonly plan: DispatchPlanResponse;
  readonly alerts: AlertView[];
  readonly shift?: DispatchShiftView;
}

export interface RouterTechnicalSettings {
  readonly lunchesEnabled: boolean;
  readonly departureLatenessToleranceSec: number;
  readonly taskStartLatenessToleranceSec: number;
  /** Customer-window lateness allowance, measured from the original window. */
  readonly windowLatenessToleranceSec: number;
  readonly trafficEnabled: boolean;
  readonly equipmentEnabled: boolean;
  readonly travelTimeMode: 'graph_with_access_buffer' | 'fixed_normative';
  readonly accessBufferSec: number;
  readonly fixedTravelTimeSec: number;
  readonly earlyFinishReplanThresholdSec: number;
  readonly taskOverrunToleranceSec: number;
  readonly routerContextVersion: string;
}

export interface AuthSession {
  readonly token: string;
  readonly role: 'dispatcher';
  readonly expiresAt: number;
}

/** Which interface an integration key replaces (context/41 §5, D-31). */
export type ApiTokenCategory = 'client' | 'eng' | 'client_eng' | 'master';

/** Non-secret record of an integration key; the secret itself is never listed. */
export interface ApiTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly category: ApiTokenCategory;
  readonly createdAt: number;
  /** Unix-epoch seconds, or null for a key that never expires. */
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

/** The creation response: the only moment the secret is ever visible. A fresh key
 * cannot be revoked yet, so the record carries no revocation stamp. */
export type CreatedApiToken = Omit<ApiTokenSummary, 'revokedAt'> & {
  readonly token: string;
};

export interface EngineerAuthSession {
  readonly token: string;
  readonly role: 'engineer';
  readonly expiresAt: number;
}

export interface EngineerPlanResponse {
  readonly planAsOf: number | null;
  readonly origin: 'auto' | 'manual' | null;
  readonly revision: number | null;
  readonly route: PlanRouteView | null;
  readonly requests: RequestView[];
}

export interface PlanDelta {
  readonly transferred: number;
  readonly shifted: number;
  readonly slaBefore: number;
  readonly slaAfter: number;
  readonly solveMs: number;
  readonly notes: string[];
}

export interface PolicyComparisonMetrics {
  readonly requestsTotal: number;
  readonly assignedCount: number;
  readonly unassignedCount: number;
  readonly urgentTotal: number;
  readonly urgentAssignedCount: number;
  readonly engineersUsed: number;
  readonly distanceKm: number;
  readonly travelTimeSec: number;
  readonly workTimeSec: number;
  readonly waitingTimeSec: number;
  readonly lunchTimeSec: number;
  readonly lateAssignedCount: number;
  readonly totalLatenessSec: number;
  readonly minWindowSlackSec: number | null;
  readonly workloadSpreadSec: number;
  readonly maxWorkloadSec: number;
}

export interface PolicyComparisonRow {
  readonly strategyId: StrategyId;
  readonly kind: 'policy' | 'baseline';
  readonly additionalEngineers?: number;
  readonly isUsable: boolean;
  readonly calculationMs: number;
  readonly metrics: PolicyComparisonMetrics;
}

export interface PolicyComparisonResponse {
  readonly inputPublicationId: string;
  readonly inputHash: string;
  readonly routerContextVersion: string;
  readonly computedAt: number;
  readonly searchBudgetMs: number;
  readonly rows: PolicyComparisonRow[];
}

export type DataUploadMode = 'new_region' | 'append_requests';

export interface DataUploadRequest {
  readonly externalId: string;
  readonly addressText: string;
  readonly lat: number;
  readonly lon: number;
  readonly serviceDurationSec: number;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
  readonly priority: 'normal' | 'urgent';
  readonly requiredSkill: 'local' | 'connection' | 'emergency';
  readonly requiredTransport?: 'car' | 'walk' | 'bike' | 'transit';
  readonly requiredEquipment?: EquipmentType;
  readonly workType?: string;
}

export interface DataUploadEngineer {
  readonly externalId: string;
  readonly displayName: string;
  readonly skills: Array<'local' | 'connection' | 'emergency'>;
  readonly transportType: 'car' | 'walk' | 'bike' | 'transit';
  readonly start: { readonly lat: number; readonly lon: number };
  readonly shiftStartAt: number;
  readonly shiftEndAt: number;
}

export interface DataUploadFile {
  readonly schemaVersion: '1.0';
  readonly mode: DataUploadMode;
  readonly region: string;
  readonly sourceVersion: string;
  readonly requests: DataUploadRequest[];
  readonly engineers?: DataUploadEngineer[];
  readonly depot?: { readonly addressText: string; readonly lat: number; readonly lon: number };
}

export interface DataUploadSummary {
  readonly applied: boolean;
  readonly region: string;
  readonly mode: DataUploadMode;
  readonly requestsCreated: number;
  readonly engineersCreated: number;
  readonly depotsCreated: number;
  readonly warnings: string[];
  readonly publicationId: string | null;
  readonly inputHash: string | null;
}

export interface OfficialImportSummary {
  readonly source: string;
  readonly applied: boolean;
  readonly requestsCreated: number;
  readonly requestsSkippedAsDuplicate: number;
  readonly engineersCreated: number;
  readonly depotsCreated: number;
  readonly requestsWithoutCoordinates: number;
  readonly warnings: string[];
  readonly errors: string[];
}
