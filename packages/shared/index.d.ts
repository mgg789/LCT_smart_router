/**
 * Dispatcher-facing wire contract shared by `apps/api` and `apps/web`.
 *
 * Absolute times are Unix-epoch seconds; local formatting stays in the UI.
 * This package is types only: both apps import it with `import type`.
 */

export type PolicyId = 'compact' | 'fast' | 'sla' | 'balanced' | 'eco' | 'covering';
export type StrategyId = PolicyId | 'baseline';
export type EquipmentType = 'router' | 'set_top_box' | 'smart_speaker';

/** Advisory finding: never changes or rejects a structurally valid import. */
export interface ImportQualityFinding {
  readonly code: string;
  readonly layer: 'rules' | 'statistics' | 'student';
  readonly count: number;
  readonly examples: readonly string[];
  readonly message: string;
  readonly score?: number;
}

/** Immutable server-side preparation, owned by the authenticated dispatcher for 24 hours. */
export interface ImportPreparationView {
  readonly prepareId: string;
  readonly source: string;
  readonly immutableBatchHash: string;
  readonly versions: {
    readonly rules: string;
    readonly statistics: string;
    readonly student: string;
    readonly transform?: string;
  };
  readonly expiresAt: number;
  readonly findings: readonly ImportQualityFinding[];
}

/** UI acknowledgement callback; false cancels without committing business data. */
export type ReviewImportQuality = (report: ImportPreparationView) => Promise<boolean>;

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

/** Business routing tiers; qualification and a customer's urgency flag are independent. */
export type WorkCategory = 'emergency' | 'connection' | 'service';

/** Canonical public work catalogue used by request forms and import review. */
export interface WorkTypeView {
  readonly code: string;
  readonly title: string;
  readonly category: WorkCategory;
  readonly categoryTitle: string;
  readonly serviceDurationSec: number;
  readonly requiredSkill: 'local' | 'connection' | 'emergency';
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
  readonly workCategory?: WorkCategory;
  readonly receivedAt?: number | null;
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
  /** False only when an imported source explicitly marks this walking crew as no-transit. */
  readonly transitEligible?: boolean;
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
  /** Default morning capacity by transport; values are dispatcher-owned settings. */
  readonly equipmentCapacityWalk: number;
  readonly equipmentCapacityBike: number;
  readonly equipmentCapacityCar: number;
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
  readonly equipmentCapacityWalk?: number;
  readonly equipmentCapacityBike?: number;
  readonly equipmentCapacityCar?: number;
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
  readonly attendanceGraceUntil?: number | null;
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
  readonly kind: 'job' | 'lunch' | 'wait' | 'start' | 'handoff' | 'delivery' | 'office_pickup';
  readonly logistics?: {
    readonly logistics_id: string;
    readonly kind: 'donor_delivery' | 'office_pickup';
    readonly request_id: string;
    readonly equipment_type: 'router' | 'set_top_box' | 'smart_speaker';
  } | null;
  /** Router handoff metadata is snake_case to match the core result contract. */
  readonly handoff?: {
    readonly handoff_id: string;
    readonly donor_engineer_id: string;
    readonly receiver_engineer_id: string;
    readonly request_id: string;
    readonly items: {
      readonly router: number;
      readonly set_top_box: number;
      readonly smart_speaker: number;
    };
  } | null;
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

export type TravelSource = 'approximate' | 'road_matrix' | 'route_api' | 'traffic_api' | 'metro';

export interface PlanLegView {
  readonly legId: string;
  readonly fromStopId: string | null;
  readonly toStopId: string;
  readonly departureAt: number;
  readonly arrivalAt: number;
  readonly travelTimeSec: number;
  readonly distanceKm: number;
  readonly travelSource: TravelSource;
  /** Optional access/metro/egress geometry while `geometry` remains the aggregate leg. */
  readonly segments?: ReadonlyArray<{
    readonly geometry: {
      readonly points: ReadonlyArray<{ readonly lat: number; readonly lon: number }>;
    };
    readonly travelSource: TravelSource;
    readonly travelTimeSec: number;
    readonly distanceKm: number;
    readonly geometryProvider?: 'twogis' | 'yandex';
  }>;
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
  readonly status: 'pending' | 'assigned' | 'unassigned' | 'in_progress' | 'done';
  readonly engineerId: string | null;
  readonly reasons: AssignmentReasons;
}

export interface PlanView {
  readonly revision: number;
  readonly origin: 'auto' | 'manual' | 'restore';
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
  readonly expectedPriorityVersion?: string;
  readonly expectedRequestVersion?: number;
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

/** Durable current/predecessor pair; eligibility is rechecked transactionally on restore. */
export interface PlanHistoryResponse {
  readonly current: PlanView | null;
  readonly previous: PlanView | null;
  readonly eligibility: { readonly eligible: boolean; readonly reason: string | null };
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
  /** The published task has no applied plan with the same input hash yet. */
  readonly calculating?: boolean;
  readonly routerPhase?: 'building' | 'ready' | 'error';
  readonly routerMessage?: string | null;
  readonly geometryDone?: number;
  readonly geometryTotal?: number;
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
  /** New ordinary arrivals stay unassigned without automatic replanning; default false. */
  readonly ordinaryReplanningDisabled?: boolean;
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
  /** Disable all lateness and terminal shift/window allowances; default false. */
  readonly strictTimeWindows?: boolean;
  readonly lunchesEnabled: boolean;
  readonly metroEnabled: boolean;
  readonly departureLatenessToleranceSec: number;
  readonly taskStartLatenessToleranceSec: number;
  /** Customer-window lateness allowance, measured from the original window. */
  readonly windowLatenessToleranceSec: number;
  readonly trafficEnabled: boolean;
  readonly equipmentEnabled: boolean;
  /** Reserved for a future handoff workflow; the UI keeps it disabled by default. */
  readonly equipmentTransfersEnabled: boolean;
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

/**
 * State of the dashboard MCP server for the Settings → API tab. The pin itself never
 * travels back — only its presence and the last four characters.
 */
export interface McpSettingsView {
  readonly enabled: boolean;
  readonly pinSet: boolean;
  readonly pinLast4: string | null;
  /** True while an agent has called an MCP tool within the last half a minute. */
  readonly activeNow: boolean;
  readonly lastToolName: string | null;
  /** Unix-epoch seconds of the most recent tool call, or null. */
  readonly lastToolCallAt: number | null;
  /** Transport path on this origin, e.g. `/api/v1/mcp`. */
  readonly endpoint: string;
}

export interface EngineerAuthSession {
  readonly token: string;
  readonly role: 'engineer';
  readonly expiresAt: number;
}

export interface EngineerPlanResponse {
  readonly planAsOf: number | null;
  readonly origin: 'auto' | 'manual' | 'restore' | null;
  readonly revision: number | null;
  readonly route: PlanRouteView | null;
  readonly requests: RequestView[];
}

/** One short line in the replan panel. A request line opens that request. */
export interface PlanDeltaLine {
  readonly requestId: string | null;
  /** Engineer display name for a lunch move. Request lines leave this empty. */
  readonly engineerName: string | null;
  readonly text: string;
}

export interface PlanDelta {
  readonly transferred: number;
  readonly shifted: number;
  readonly slaBefore: number;
  readonly slaAfter: number;
  readonly solveMs: number;
  readonly lines: PlanDeltaLine[];
  /** Assigned jobs before and after. Absent on deltas recorded before this field existed. */
  readonly assignedBefore?: number;
  readonly assignedAfter?: number;
  /** Sum of route distance, kilometres, one decimal. */
  readonly distanceBeforeKm?: number;
  readonly distanceAfterKm?: number;
  /** Routes that actually carry a job. */
  readonly engineersBefore?: number;
  readonly engineersAfter?: number;
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

/** Canonical columns recognised by the tabular import review; indices are zero-based. */
export type TabularField =
  | 'externalId'
  | 'addressText'
  | 'lat'
  | 'lon'
  | 'workType'
  | 'workCategory'
  | 'duration'
  | 'windowStart'
  | 'windowEnd'
  | 'priority'
  | 'requiredSkill'
  | 'brigade'
  | 'transportType'
  | 'requiredTransport';

/** Bounded source bytes and explicit parsing choices; analysis never imports business data. */
export interface TabularFileInput {
  readonly fileName: string;
  readonly payloadBase64: string;
  readonly sheet?: number;
  readonly encoding?: 'auto' | 'utf8' | 'windows1251' | 'utf16le';
  readonly delimiter?: 'auto' | ',' | ';' | '\t' | '|';
  readonly headerRow?: number;
}

/** Source rows retain parsed record numbers for diagnostics and explicit correction. */
export interface TabularAnalysis {
  readonly sourceHash: string;
  readonly format: 'csv' | 'tsv' | 'xlsx';
  readonly encoding: string;
  readonly delimiter: string | null;
  readonly sheetNames: string[];
  readonly selectedSheet: number;
  readonly headerRow: number;
  readonly headers: string[];
  readonly rows: Array<{ readonly rowNumber: number; readonly values: string[] }>;
  readonly columns: Partial<Record<TabularField, number>>;
  readonly missing: Array<{ readonly field: TabularField; readonly count: number }>;
  readonly officeAddress: string | null;
  readonly notices: string[];
  readonly durationUnit: 'minutes' | 'seconds';
}

/** Dispatcher-approved missing-value defaults and cell corrections; no silent row exclusions. */
export interface TabularCompletionOptions {
  readonly mode: DataUploadMode;
  readonly region: string;
  readonly workDate: string;
  readonly columns: Partial<Record<TabularField, number>>;
  readonly defaults: Partial<Record<TabularField, string>>;
  readonly durationUnit: 'minutes' | 'seconds';
  readonly depot: { readonly addressText: string; readonly lat?: number; readonly lon?: number };
  readonly engineers: {
    readonly count: number;
    readonly transportType: 'car' | 'walk' | 'bike' | 'transit';
    readonly skills: Array<'local' | 'connection' | 'emergency'>;
    readonly shiftStart: string;
    readonly shiftEnd: string;
  };
  readonly edits: Array<{
    readonly rowNumber: number;
    readonly field: TabularField;
    readonly value: string;
  }>;
}

/** Either a complete canonical package or actionable cell errors; neither outcome applies a plan. */
export interface TabularConversion {
  readonly file: DataUploadFile | null;
  readonly issues: Array<{
    readonly rowNumber: number | null;
    readonly field: TabularField | 'depot' | 'engineers' | 'workDate';
    readonly message: string;
  }>;
  readonly notices: string[];
}

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
  /** Required for an unknown named work type; known types use the canonical catalogue. */
  readonly workCategory?: WorkCategory;
  /** Actual occurrence/receipt in source time; absent means known from the day's start. */
  readonly receivedAt?: number;
}

export interface DataUploadEngineer {
  readonly externalId: string;
  readonly displayName: string;
  readonly skills: Array<'local' | 'connection' | 'emergency'>;
  readonly transportType: 'car' | 'walk' | 'bike' | 'transit';
  readonly start: { readonly lat: number; readonly lon: number };
  readonly shiftStartAt: number;
  readonly shiftEndAt: number;
  readonly equipmentStock?: {
    readonly router: number;
    readonly setTopBox: number;
    readonly smartSpeaker: number;
  };
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

/** Result returned after the dispatcher imports a native OSRM road resource. */
export interface RoadImportSummary {
  readonly operationId: string;
  readonly status: 'accepted' | 'replayed';
  readonly graphVersion: string;
  readonly routerContextVersion: string;
  readonly inputSha256: string;
  readonly profiles: ReadonlyArray<'car' | 'walk' | 'bike' | 'transit'>;
  readonly nodes: number;
  readonly edges: number;
}
