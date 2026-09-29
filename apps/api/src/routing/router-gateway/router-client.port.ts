import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { RouterTaskSnapshot } from '../mount-data-eng/snapshot.types';
import type { RouterResult } from './result.types';

/** Poll identity. It deliberately omits the plan so a status check stays small. */
export interface RouterResultStatus {
  readonly status: RouterResult['status'];
  readonly result_id: string | null;
  readonly input_publication_id: string | null;
  readonly input_hash: string | null;
  readonly computed_at: number | null;
  readonly errors: ReadonlyArray<{ readonly code: string; readonly message: string }>;
}

/** Read-only proposal evaluated against a fresh sys projection and existing job orders. */
export interface WindowProposalInput {
  snapshot: RouterTaskSnapshot;
  request_id: string;
  routes: Record<string, string[]>;
  day_end_at: number;
}

/** Frozen-route witness; no mutation occurs until sys rechecks its captured state. */
export interface LogisticsProposalInput {
  snapshot: RouterTaskSnapshot;
  request_id: string;
  receiver_engineer_id: string;
  expected_context_version: string;
  routes: Record<
    string,
    Array<{
      kind: string;
      request_id: string | null;
      lat: number;
      lon: number;
      start_at: number;
      end_at: number;
    }>
  >;
  depots: Array<{ id: string; lat: number; lon: number }>;
}

/** One feasible donor detour, or a confirmed exhausted search. */
export interface LogisticsProposal {
  status: 'available' | 'none';
  router_context_version: string;
  proposal: {
    kind: 'donor_delivery';
    donor_engineer_id: string;
    at: number;
    location: { lat: number; lon: number };
    travel_delta_sec: number;
    distance_delta_m: number;
    wait_delta_sec: number;
    occupied_from_at: number;
    occupied_until_at: number;
  } | null;
}

/** One witnessed same-day slot. Neighbors are the jobs already beside the insertion. */
export interface WindowProposalSlot {
  engineerId: string;
  windowStartAt: number;
  windowEndAt: number;
  serviceStartAt: number;
  serviceEndAt: number;
  neighborRequestIds?: readonly string[];
  slackSec?: number;
}

/** A calculation witness, not a reservation or an applied assignment. */
export interface WindowProposal {
  status: 'available' | 'none';
  proposal: WindowProposalSlot | null;
  /** Earliest slot first. Empty when status is none. Older routers may omit it. */
  proposals?: readonly WindowProposalSlot[];
}

/** One native OSRM JSON or gzip payload forwarded to Router Core. */
export interface RouterRoadImportInput {
  readonly operationId: string;
  readonly profile: 'car' | 'walk' | 'bike' | 'transit';
  readonly source?: string;
  readonly payloadBase64: string;
}

/** Accepted graph merge and the context identity it invalidated. */
export interface RouterRoadImportResult {
  readonly operationId: string;
  readonly status: 'accepted' | 'replayed';
  readonly graphVersion: string;
  readonly routerContextVersion: string;
  readonly inputSha256: string;
  readonly profiles: ReadonlyArray<'car' | 'walk' | 'bike' | 'transit'>;
  readonly nodes: number;
  readonly edges: number;
}

export interface RouterTechnicalSettings {
  /** Disable all lateness and terminal shift/window allowances; default false. */
  readonly strictTimeWindows?: boolean;
  readonly lunchesEnabled: boolean;
  readonly departureLatenessToleranceSec: number;
  readonly taskStartLatenessToleranceSec: number;
  /** Allowed lateness measured against the customer's original service window. */
  readonly windowLatenessToleranceSec?: number;
  /** Whether Router may use traffic-aware travel times. */
  readonly trafficEnabled?: boolean;
  /** Whether pedestrian journeys may use the offline Moscow metro graph. */
  readonly metroEnabled?: boolean;
  /** Allow same-region, capacity-safe paired equipment meetings. */
  readonly equipmentTransfersEnabled?: boolean;
  /** Whether Router must enforce equipment compatibility. */
  readonly equipmentEnabled?: boolean;
  /** How Router converts a graph quote into the planning duration of a road leg. */
  readonly travelTimeMode: 'graph_with_access_buffer' | 'fixed_normative';
  /** Parking, building access and ascent added to a non-zero graph journey. */
  readonly accessBufferSec: number;
  /** Whole journey duration used by the normative fallback mode. */
  readonly fixedTravelTimeSec: number;
  /** Minimum saved on-site time that justifies an early-finish replan. */
  readonly earlyFinishReplanThresholdSec: number;
  /** Allowed on-site overrun before the engineer is removed from free capacity. */
  readonly taskOverrunToleranceSec: number;
}

/** Dispatcher view of the Redis-beta route-response cache. */
export interface RouteCacheStatus {
  readonly beta: true;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly memorySource: 'redis' | 'disk' | 'none';
  readonly usedBytes: number;
  readonly routePayloadBytes: number;
  readonly keys: number;
  readonly normalBytesPerSec: number | null;
  readonly observedBytesPerSec: number | null;
  readonly leak: {
    readonly code: 'CACHE_MEMORY_LEAK';
    readonly normalBytesPerSec: number;
    readonly observedBytesPerSec: number;
    readonly windowSec: number;
  } | null;
}

export interface RouterTechnicalSettingsState extends RouterTechnicalSettings {
  readonly routerContextVersion: string;
}

export interface UpdateRouterTechnicalSettings extends RouterTechnicalSettings {
  readonly operationId: string;
  readonly expectedContextVersion: string;
}

export interface RouterTechnicalSettingsUpdate extends RouterTechnicalSettingsState {
  readonly operationId: string;
  readonly status: 'accepted';
}

export const COMPARISON_STRATEGIES = [
  'fast',
  'compact',
  'sla',
  'balanced',
  'eco',
  'covering',
  'baseline',
] as const;
export type ComparisonStrategy = (typeof COMPARISON_STRATEGIES)[number];

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

export interface RouterSimulationPatch {
  readonly catalog?: boolean;
  readonly policy_id?: string;
  readonly lunches_enabled?: boolean;
  readonly metro_enabled?: boolean;
  readonly traffic_enabled?: boolean;
  readonly equipment_enabled?: boolean;
  readonly equipment_transfers_enabled?: boolean;
  /** Marks one offline engineer online on the simulation copy only. */
  readonly bring_online_engineer_id?: string;
  readonly window?: {
    readonly request_id: string;
    readonly window_start_at: number;
    readonly window_end_at: number;
  };
  readonly pin?: { readonly request_id: string; readonly engineer_id: string };
  readonly unassign_request_id?: string;
}

export interface SimulationCounts {
  readonly assigned_count: number;
  readonly unassigned_count: number;
  readonly late_assigned_count: number;
  readonly total_lateness_sec: number;
  readonly distance_km: number;
  /** Crews that carry a job. Older stored rows omit this. */
  readonly engineers_used?: number;
  /** Reserve crews whose ids start with `covering-`. Not the named shift roster. */
  readonly additional_engineers?: number;
}

export interface SimulationRouteSegment {
  readonly travel_source: string;
  readonly points: readonly { readonly lat: number; readonly lon: number }[];
}

export interface SimulationRoute {
  readonly engineer_id: string;
  readonly segments: readonly SimulationRouteSegment[];
}

export interface RouterSimulation {
  readonly input_hash: string;
  readonly input_publication_id: string;
  readonly router_context_version: string;
  readonly patch_hash: string;
  readonly method: 'insertion' | 'bounded' | 'catalog';
  readonly cached: boolean;
  readonly delta?: {
    readonly assigned: number;
    readonly unassigned: number;
    readonly late_assigned: number;
    readonly total_lateness_sec: number;
    readonly distance_km: number;
    readonly transfers: number;
    readonly before: SimulationCounts;
    readonly after: SimulationCounts;
  };
  readonly routes?: readonly SimulationRoute[];
  readonly strategies?: readonly {
    readonly strategy_id: string;
    readonly metrics: SimulationCounts;
    readonly routes: readonly SimulationRoute[];
  }[];
}

export interface PolicyComparison {
  readonly inputPublicationId: string;
  readonly inputHash: string;
  readonly routerContextVersion: string;
  readonly computedAt: number;
  readonly searchBudgetMs: number;
  readonly rows: ReadonlyArray<{
    readonly strategyId: ComparisonStrategy;
    readonly kind: 'policy' | 'baseline';
    readonly additionalEngineers?: number;
    readonly isUsable: boolean;
    readonly calculationMs: number;
    readonly metrics: PolicyComparisonMetrics;
  }>;
}

/**
 * How the System Layer reaches Router Core.
 *
 * The direction is settled: **sys polls Router**, Router never writes into sys. That is
 * what makes the bus switchable -- emergency manual mode simply stops applying what this
 * client returns, without Router needing to know or stop computing
 * (context/32 section 7.2).
 *
 * A port keeps the optional null transport and private-network HTTP transport interchangeable.
 */
export abstract class RouterClient {
  /** Search equipment delivery without holding a database transaction. */
  proposeLogistics(_input: LogisticsProposalInput): Promise<LogisticsProposal> {
    return Promise.reject(new Error('Equipment logistics is unavailable'));
  }
  /** Imports one validated offline OSRM resource into Router's persistent graph. */
  importRoadData(_input: RouterRoadImportInput): Promise<RouterRoadImportResult> {
    throw SysError.notConfigured('Router road import');
  }
  /** Finds an actual same-day insertion without altering the live plan. */
  proposeWindow(_input: WindowProposalInput): Promise<WindowProposal> {
    throw SysError.notConfigured('Router window proposal');
  }
  /** Evaluates explicit manual orders without changing or optimizing the plan. */
  evaluateManual(_input: ManualEvaluationInput): Promise<ManualEvaluation> {
    throw SysError.notConfigured('Router manual evaluation');
  }
  /** The current result, whatever its status. */
  abstract getResult(): Promise<RouterResult>;

  /**
   * Identity of the current result without the plan body.
   *
   * The default reads the full package. The HTTP client overrides it so a
   * half-second poll does not parse road geometry on every tick.
   */
  getResultStatus(): Promise<RouterResultStatus> {
    return this.getResult().then((result) => ({
      status: result.status,
      result_id: result.result_id ?? null,
      input_publication_id: result.input_publication_id ?? null,
      input_hash: result.input_hash ?? null,
      computed_at: result.computed_at ?? null,
      errors: result.errors.map((item) => ({ code: item.code, message: item.message })),
    }));
  }

  /**
   * The context version in force **now**.
   *
   * Read separately from any result package on purpose: a result cannot report its own
   * currency, and an answer computed before a map change must not be marked with the new
   * version (context/33 section 7).
   */
  abstract getActiveContextVersion(): Promise<string | null>;

  /** Route-response cache size, memory source and the learned growth check. */
  getRouteCache(): Promise<RouteCacheStatus> {
    throw SysError.notConfigured('Router Core route cache');
  }

  /** Deletes cached route-engine3 bodies. The policy catalog stays. */
  clearRouteCache(): Promise<RouteCacheStatus> {
    throw SysError.notConfigured('Router Core route cache');
  }

  /** Turns the route-response cache on or off. Redis itself keeps running. */
  setRouteCacheEnabled(_enabled: boolean): Promise<RouteCacheStatus> {
    throw SysError.notConfigured('Router Core route cache');
  }

  /** Reads the complete Router-owned technical settings revision. */
  getTechnicalSettings(): Promise<RouterTechnicalSettingsState> {
    throw SysError.notConfigured('Router Core technical settings');
  }

  /** Replaces settings through Router's idempotent context-version CAS operation. */
  updateTechnicalSettings(
    _input: UpdateRouterTechnicalSettings,
  ): Promise<RouterTechnicalSettingsUpdate> {
    throw SysError.notConfigured('Router Core technical settings');
  }

  /** Compares every prepared policy and FIFO on one immutable current publication. */
  getPolicyComparison(): Promise<PolicyComparison> {
    throw SysError.notConfigured('Router Core policy comparison');
  }

  /** What-if on the ready publication. Does not accept the result into the working plan. */
  simulate(_patch: RouterSimulationPatch): Promise<RouterSimulation> {
    throw SysError.notConfigured('Router Core simulation');
  }

  /** Runs dry Monte-Carlo situation predictions for one fixed plan; never optimizes. */
  predictSituation(_input: SituationPredictionInput): Promise<SituationPrediction> {
    throw SysError.notConfigured('Router Core situation prediction');
  }

  /** Reads the active plan-assessment simulator calibration. */
  getPredictCalibration(): Promise<RouterPredictCalibration> {
    throw SysError.notConfigured('Router Core predict calibration');
  }

  /** Replaces the plan-assessment calibration; used by the AI self-calibration contour. */
  updatePredictCalibration(
    _input: UpdatePredictCalibrationInput,
  ): Promise<RouterPredictCalibration> {
    throw SysError.notConfigured('Router Core predict calibration');
  }

  /** Cached Moscow forecast used by the map badge. Multiplier 1 when weather is calm. */
  getWeather(): Promise<RouterWeather> {
    throw SysError.notConfigured('Router Core weather');
  }

  abstract isConfigured(): boolean;
}

/** Identity-bound fixed-order evaluation request. */
export interface ManualEvaluationInput {
  readonly input_hash: string;
  readonly router_context_version: string;
  readonly routes: Record<string, string[]>;
}

/** Identity-bound dry prediction request; routes are fixed orders, never a new plan. */
export interface SituationPredictionInput {
  readonly input_hash: string;
  readonly router_context_version: string;
  readonly routes: Record<string, string[]>;
  readonly simulations: number;
  readonly as_of?: number | null;
  readonly completed?: Record<string, string[]>;
  readonly cancel_rate?: number | null;
  /** Current API working-set epoch; Core drops persisted learned state after a reset. */
  readonly working_set_generation?: number;
  /** Private paired-evaluation override; callers must not expose this on public DTOs. */
  readonly calibration_override?: PredictCalibrationDocument;
  /** Reuses Monte-Carlo draws across baseline and shadow candidate evaluations. */
  readonly scenario_seed?: string;
}

/** Per-request dry outcome of the situation prediction. */
export interface SituationRequestPrediction {
  /** Share of simulations where the visit finished after its window ended. */
  readonly breach_prob: number | null;
  readonly expected_late_sec: number;
  readonly p90_late_sec: number;
  /** Share of simulations where an upstream cancellation removed the visit. */
  readonly cancel_rate_sim: number;
}

/** Cached Open-Meteo reading. `trafficMultiplier` already scales car travel in Router. */
export interface RouterWeather {
  readonly observed_at: number;
  readonly temperature_c: number | null;
  readonly weather_code: number | null;
  readonly kind: 'clear' | 'cloud' | 'rain' | 'snow' | 'storm' | 'unknown';
  readonly label: string;
  readonly traffic_multiplier: number;
}

/** Dry probabilities only: the prediction never contains a plan or a decision. */
export interface SituationPrediction {
  readonly input_hash: string;
  readonly router_context_version: string;
  readonly calibration_version: string;
  readonly simulations: number;
  readonly assumptions: {
    readonly source: 'factory' | 'learned';
    readonly cancel_rate: number;
    readonly service_cv: number;
    readonly leg_cv: { readonly short: number; readonly long: number };
    readonly regimes: Record<string, { readonly prob: number; readonly mult: number }>;
    readonly note: string;
  };
  readonly plan: {
    /** Share of simulations with zero breached visits (0..1). */
    readonly robustness: number;
    readonly visits_total: number;
    readonly expected_late: number;
    readonly expected_late_share: number;
    readonly p95_late_count: number;
    readonly p95_max_late_sec: number;
    readonly expected_cancellations: number;
  };
  readonly requests: Record<string, SituationRequestPrediction>;
  readonly engineers: Record<string, { readonly overrun_prob: number }>;
}

/**
 * Complete dispersion parameters of the plan-assessment simulator. The numbers
 * come from execution facts (learned) or from the lab assumptions (factory);
 * regimes stay factory until a real weather-linked execution history exists.
 */
export interface PredictCalibrationDocument {
  /** Monotonic data epoch; protects Router from a delayed pre-reset calibration PUT. */
  readonly working_set_generation?: number;
  readonly service_cv: number;
  readonly leg_cv_short: number;
  readonly leg_cv_long: number;
  readonly cancel_rate: number;
  readonly source: 'factory' | 'learned';
  readonly learned_from: null | {
    readonly service_samples: number;
    readonly leg_samples: number;
    readonly cancel_requests: number;
    readonly execution_days: number;
  };
  readonly regimes: ReadonlyArray<{
    readonly name: string;
    readonly probability: number;
    readonly travel_multiplier: number;
  }>;
  readonly weather_multipliers: ReadonlyArray<WeatherMultiplierCalibration>;
}

/** Region/profile-specific candidate evaluated against forward-day execution facts. */
export interface WeatherMultiplierCalibration {
  readonly region: string;
  readonly transport_type: 'car' | 'walk' | 'bike' | 'transit';
  readonly kind: 'rain' | 'snow' | 'storm';
  readonly multiplier: number;
  readonly source: 'learned';
  readonly observations: number;
  readonly days: number;
  readonly baseline_travel_error: number;
  readonly candidate_travel_error: number;
  readonly baseline_brier: number;
  readonly candidate_brier: number;
  readonly validation_version: string;
}

export interface RouterPredictCalibration {
  readonly version: string;
  readonly calibration: PredictCalibrationDocument;
}

export interface UpdatePredictCalibrationInput {
  readonly operationId: string;
  /** Optimistic lock on the current calibration version; absent means last-write-wins. */
  readonly expectedVersion?: string;
  readonly calibration: PredictCalibrationDocument;
}

/** Exact lexicographic policy evidence on the same snapshot and travel resources. */
export interface ManualEvaluation {
  readonly input_hash: string;
  readonly router_context_version: string;
  readonly policy_id: string;
  readonly feasible: boolean;
  readonly degraded: boolean;
  readonly criterion: string | null;
  readonly before: number[];
  readonly after: number[] | null;
}

/**
 * Stands in while Router Core is not wired.
 *
 * Answers `pending`, which is the truthful state: a result has been asked for and none is
 * available. It never fabricates a plan, and the application is fully usable without it --
 * requests are taken, the task is published, and nothing is automatically distributed.
 */
@Injectable()
export class NullRouterClient extends RouterClient {
  private readonly logger = new Logger(NullRouterClient.name);
  private warned = false;

  async getResult(): Promise<RouterResult> {
    if (!this.warned) {
      this.logger.log('Router Core is not configured; results stay pending');
      this.warned = true;
    }
    return {
      schema_version: '1.0',
      status: 'pending',
      result_id: null,
      input_publication_id: null,
      input_hash: null,
      planning_as_of: null,
      computed_at: null,
      router_context_version: null,
      main: null,
      baseline: null,
      errors: [],
    };
  }

  async getActiveContextVersion(): Promise<string | null> {
    return null;
  }

  override async getTechnicalSettings(): Promise<RouterTechnicalSettingsState> {
    throw SysError.notConfigured('Router Core');
  }

  override async updateTechnicalSettings(): Promise<RouterTechnicalSettingsUpdate> {
    throw SysError.notConfigured('Router Core');
  }

  override async getPolicyComparison(): Promise<PolicyComparison> {
    throw SysError.notConfigured('Router Core');
  }

  isConfigured(): boolean {
    return false;
  }
}
