import { z } from 'zod';
import { SysError } from '../../common/errors';
import type { RouterResult } from './result.types';
import { routerResultSchema } from './result.types';
import {
  COMPARISON_STRATEGIES,
  type ManualEvaluation,
  type ManualEvaluationInput,
  type PolicyComparison,
  RouterClient,
  type RouterPredictCalibration,
  type RouterResultStatus,
  type RouterRoadImportInput,
  type RouterRoadImportResult,
  type RouterTechnicalSettingsState,
  type RouterTechnicalSettingsUpdate,
  type RouterWeather,
  type SituationPrediction,
  type SituationPredictionInput,
  type UpdatePredictCalibrationInput,
  type UpdateRouterTechnicalSettings,
  type WindowProposal,
  type WindowProposalInput,
} from './router-client.port';

const predictCalibrationSchema = z.object({
  version: z.string().min(1),
  calibration: z.object({
    service_cv: z.number().min(0).max(1),
    leg_cv_short: z.number().min(0).max(1),
    leg_cv_long: z.number().min(0).max(1),
    cancel_rate: z.number().min(0).max(1),
    source: z.enum(['factory', 'learned']),
    learned_from: z
      .object({
        service_samples: z.number().int().nonnegative(),
        leg_samples: z.number().int().nonnegative(),
        cancel_requests: z.number().int().nonnegative(),
        execution_days: z.number().int().nonnegative(),
      })
      .nullable(),
    regimes: z.array(
      z.object({
        name: z.string(),
        probability: z.number().min(0).max(1),
        travel_multiplier: z.number(),
      }),
    ),
  }),
});

const situationPredictionSchema = z.object({
  input_hash: z.string().length(64),
  router_context_version: z.string().min(1),
  calibration_version: z.string().min(1),
  simulations: z.number().int().positive(),
  assumptions: z.object({
    source: z.enum(['factory', 'learned']),
    cancel_rate: z.number(),
    service_cv: z.number(),
    leg_cv: z.object({ short: z.number(), long: z.number() }),
    regimes: z.record(z.string(), z.object({ prob: z.number(), mult: z.number() })),
    note: z.string(),
  }),
  plan: z.object({
    robustness: z.number().min(0).max(1),
    visits_total: z.number().int().nonnegative(),
    expected_late: z.number().nonnegative(),
    expected_late_share: z.number().min(0).max(1),
    p95_late_count: z.number().int().nonnegative(),
    p95_max_late_sec: z.number().nonnegative(),
    expected_cancellations: z.number().nonnegative(),
  }),
  requests: z.record(
    z.string(),
    z.object({
      breach_prob: z.number().min(0).max(1).nullable(),
      expected_late_sec: z.number().nonnegative(),
      p90_late_sec: z.number().nonnegative(),
      cancel_rate_sim: z.number().min(0).max(1),
    }),
  ),
  engineers: z.record(z.string(), z.object({ overrun_prob: z.number().min(0).max(1) })),
});

const comparisonMetricsSchema = z.object({
  requests_total: z.number().int().nonnegative(),
  assigned_count: z.number().int().nonnegative(),
  unassigned_count: z.number().int().nonnegative(),
  urgent_total: z.number().int().nonnegative(),
  urgent_assigned_count: z.number().int().nonnegative(),
  engineers_used: z.number().int().nonnegative(),
  distance_km: z.number().nonnegative(),
  travel_time_sec: z.number().int().nonnegative(),
  work_time_sec: z.number().int().nonnegative(),
  waiting_time_sec: z.number().int().nonnegative(),
  lunch_time_sec: z.number().int().nonnegative(),
  late_assigned_count: z.number().int().nonnegative().optional().default(0),
  total_lateness_sec: z.number().int().nonnegative().optional().default(0),
  min_window_slack_sec: z.number().int().nullable().optional().default(null),
  workload_spread_sec: z.number().int().nonnegative().optional().default(0),
  max_workload_sec: z.number().int().nonnegative().optional().default(0),
});

const policyComparisonSchema = z.object({
  input_publication_id: z.string().min(1),
  input_hash: z.string().length(64),
  router_context_version: z.string().min(1),
  computed_at: z.number().int().nonnegative(),
  search_budget_ms: z.number().int().positive().max(8_000),
  rows: z.array(
    z.object({
      strategy_id: z.enum(COMPARISON_STRATEGIES),
      kind: z.enum(['policy', 'baseline']),
      additional_engineers: z.number().int().nonnegative().default(0),
      is_usable: z.boolean(),
      calculation_ms: z.number().int().nonnegative(),
      summary: comparisonMetricsSchema,
    }),
  ),
});

const technicalSettingsSchema = z.object({
  lunches_enabled: z.boolean(),
  departure_lateness_tolerance_sec: z.number().int().nonnegative().max(86_400),
  task_start_lateness_tolerance_sec: z.number().int().nonnegative().max(86_400),
  window_lateness_tolerance_sec: z.number().int().nonnegative().max(1_200).optional(),
  traffic_enabled: z.boolean().optional(),
  metro_enabled: z.boolean().optional(),
  equipment_transfers_enabled: z.boolean().optional(),
  equipment_enabled: z.boolean().optional(),
  travel_time_mode: z.enum(['graph_with_access_buffer', 'fixed_normative']),
  access_buffer_sec: z.number().int().nonnegative().max(86_400),
  fixed_travel_time_sec: z.number().int().positive().max(86_400),
  early_finish_replan_threshold_sec: z.number().int().nonnegative().max(86_400),
  task_overrun_tolerance_sec: z.number().int().nonnegative().max(86_400),
});

const routerContextSchema = z.looseObject({
  router_context_version: z.string().min(1).nullable(),
  technical_settings: technicalSettingsSchema.optional(),
});

const technicalSettingsUpdateSchema = z.object({
  operation_id: z.string().min(1),
  status: z.literal('accepted'),
  technical_settings: technicalSettingsSchema,
  router_context_version: z.string().min(1),
});

export interface HttpRouterClientOptions {
  /** Internal Router origin, without a required trailing slash. */
  readonly baseUrl: string;
  /** Maximum duration of one private-network request. */
  readonly requestTimeoutMs: number;
}

/** Reads validated results and context from Router Core over the private Docker network. */
export class HttpRouterClient extends RouterClient {
  /** Forwards one browser-uploaded native OSRM payload to the private Core boundary. */
  override async importRoadData(input: RouterRoadImportInput): Promise<RouterRoadImportResult> {
    const raw = await this.fetchJson('/v1/road-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation_id: input.operationId,
        profile: input.profile,
        ...(input.source === undefined ? {} : { source: input.source }),
        payload_base64: input.payloadBase64,
      }),
    });
    const parsed = z
      .object({
        operation_id: z.string().min(1),
        status: z.enum(['accepted', 'replayed']),
        graph_version: z.string().min(1),
        router_context_version: z.string().min(1),
        input_sha256: z.string().length(64),
        profiles: z.array(z.enum(['car', 'walk', 'bike', 'transit'])),
        nodes: z.number().int().nonnegative(),
        edges: z.number().int().nonnegative(),
      })
      .parse(raw);
    return {
      operationId: parsed.operation_id,
      status: parsed.status,
      graphVersion: parsed.graph_version,
      routerContextVersion: parsed.router_context_version,
      inputSha256: parsed.input_sha256,
      profiles: parsed.profiles,
      nodes: parsed.nodes,
      edges: parsed.edges,
    };
  }
  /** Uses canonical Router travel and scheduling, without publication side effects. */
  override async proposeWindow(input: WindowProposalInput): Promise<WindowProposal> {
    const raw = await this.fetchJson(
      '/v1/window-proposal',
      {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      },
      30_000,
    );
    return z
      .discriminatedUnion('status', [
        z.object({ status: z.literal('none'), proposal: z.null() }),
        z.object({
          status: z.literal('available'),
          proposal: z.object({
            engineerId: z.string(),
            windowStartAt: z.number().int(),
            windowEndAt: z.number().int(),
            serviceStartAt: z.number().int(),
            serviceEndAt: z.number().int(),
          }),
        }),
      ])
      .parse(raw);
  }
  private readonly baseUrl: string;
  private settingsCache: { at: number; value: RouterTechnicalSettingsState } | null = null;
  private settingsInflight: Promise<RouterTechnicalSettingsState> | null = null;

  constructor(private readonly options: HttpRouterClientOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  /** Returns only enough to tell whether the full package changed. */
  override async getResultStatus(): Promise<RouterResultStatus> {
    const raw = await this.fetchJson('/v1/result-status');
    const parsed = z
      .object({
        status: z.enum(['pending', 'partial', 'ready', 'error']),
        result_id: z.string().nullable(),
        input_publication_id: z.string().nullable(),
        input_hash: z.string().nullable(),
        computed_at: z.number().nullable(),
        errors: z.array(z.object({ code: z.string(), message: z.string() })),
      })
      .safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Router /v1/result-status response is invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** Returns the latest atomic Router package after boundary validation. */
  async getResult(): Promise<RouterResult> {
    const raw = await this.fetchJson('/v1/result');
    const parsed = routerResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Router /v1/result response is invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** Returns the resource context currently active in Router Core. */
  async getActiveContextVersion(): Promise<string | null> {
    const raw = await this.fetchJson('/v1/context');
    const parsed = routerContextSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Router /v1/context response is invalid: ${parsed.error.message}`);
    }
    return parsed.data.router_context_version;
  }

  /**
   * Reads technical settings without holding a client request on Router.
   *
   * A cached answer is returned immediately, including when it is stale.
   * The refresh runs in the background. Only the first read, before any
   * answer exists, waits for Router.
   */
  override getTechnicalSettings(): Promise<RouterTechnicalSettingsState> {
    const cached = this.settingsCache;
    const fresh = cached !== null && Date.now() - cached.at < 30_000;
    if (!fresh) this.kickSettingsRefresh();
    if (cached) return Promise.resolve(cached.value);
    return this.settingsInflight ?? this.kickSettingsRefresh();
  }

  private kickSettingsRefresh(): Promise<RouterTechnicalSettingsState> {
    if (this.settingsInflight) return this.settingsInflight;
    const pending = this.readTechnicalSettings()
      .then((value) => this.rememberSettings(value))
      .finally(() => {
        if (this.settingsInflight === pending) this.settingsInflight = null;
      });
    this.settingsInflight = pending;
    return pending;
  }

  private async readTechnicalSettings(): Promise<RouterTechnicalSettingsState> {
    const raw = await this.fetchJson('/v1/context');
    const parsed = routerContextSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.router_context_version || !parsed.data.technical_settings) {
      throw new Error(
        `Router /v1/context response is invalid: ${
          parsed.success ? 'technical settings are missing' : parsed.error.message
        }`,
      );
    }
    return toTechnicalSettings(parsed.data.technical_settings, parsed.data.router_context_version);
  }

  private rememberSettings(value: RouterTechnicalSettingsState): RouterTechnicalSettingsState {
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  /** Sends a complete CAS replacement and validates Router's accepted revision. */
  override async updateTechnicalSettings(
    input: UpdateRouterTechnicalSettings,
  ): Promise<RouterTechnicalSettingsUpdate> {
    const raw = await this.fetchJson('/v2/config/technical-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation_id: input.operationId,
        expected_context_version: input.expectedContextVersion,
        lunches_enabled: input.lunchesEnabled,
        departure_lateness_tolerance_sec: input.departureLatenessToleranceSec,
        task_start_lateness_tolerance_sec: input.taskStartLatenessToleranceSec,
        ...(input.windowLatenessToleranceSec === undefined
          ? {}
          : { window_lateness_tolerance_sec: input.windowLatenessToleranceSec }),
        ...(input.trafficEnabled === undefined ? {} : { traffic_enabled: input.trafficEnabled }),
        ...(input.equipmentTransfersEnabled === undefined
          ? {}
          : { equipment_transfers_enabled: input.equipmentTransfersEnabled }),
        ...(input.metroEnabled === undefined ? {} : { metro_enabled: input.metroEnabled }),
        ...(input.equipmentEnabled === undefined
          ? {}
          : { equipment_enabled: input.equipmentEnabled }),
        travel_time_mode: input.travelTimeMode,
        access_buffer_sec: input.accessBufferSec,
        fixed_travel_time_sec: input.fixedTravelTimeSec,
        early_finish_replan_threshold_sec: input.earlyFinishReplanThresholdSec,
        task_overrun_tolerance_sec: input.taskOverrunToleranceSec,
      }),
    });
    const parsed = technicalSettingsUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Router /v2/config/technical-settings response is invalid: ${parsed.error.message}`,
      );
    }
    const settings = this.rememberSettings(
      toTechnicalSettings(parsed.data.technical_settings, parsed.data.router_context_version),
    );
    return {
      operationId: parsed.data.operation_id,
      status: parsed.data.status,
      ...settings,
    };
  }

  /** Runs or reads Router's cached same-snapshot policy comparison. */
  override async evaluateManual(input: ManualEvaluationInput): Promise<ManualEvaluation> {
    const raw = await this.fetchJson('/v1/manual-evaluation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return z
      .object({
        input_hash: z.string().length(64),
        router_context_version: z.string(),
        policy_id: z.string(),
        feasible: z.boolean(),
        degraded: z.boolean(),
        criterion: z.string().nullable(),
        before: z.array(z.number()),
        after: z.array(z.number()).nullable(),
      })
      .parse(raw);
  }

  /** Runs Router's dry Monte-Carlo situation predictions for one fixed plan. */
  override async predictSituation(input: SituationPredictionInput): Promise<SituationPrediction> {
    const raw = await this.fetchJson('/v1/situation-predict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const parsed = situationPredictionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Router /v1/situation-predict response is invalid: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  /** Reads Router's active plan-assessment simulator calibration. */
  override async getPredictCalibration(): Promise<RouterPredictCalibration> {
    const raw = await this.fetchJson('/v1/config/predict-calibration');
    const parsed = predictCalibrationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Router /v1/config/predict-calibration response is invalid: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  /** Replaces Router's plan-assessment calibration after an optimistic version check. */
  override async updatePredictCalibration(
    input: UpdatePredictCalibrationInput,
  ): Promise<RouterPredictCalibration> {
    const raw = await this.fetchJson('/v1/config/predict-calibration', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation_id: input.operationId,
        ...(input.expectedVersion ? { expected_version: input.expectedVersion } : {}),
        calibration: input.calibration,
      }),
    });
    const parsed = predictCalibrationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Router /v1/config/predict-calibration response is invalid: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  /** Reads Router's cached Moscow forecast. Does not wait on a solve. */
  override async getWeather(): Promise<RouterWeather> {
    const raw = await this.fetchJson(
      '/v1/weather',
      {},
      Math.max(this.options.requestTimeoutMs, 4_000),
    );
    return z
      .object({
        observed_at: z.number(),
        temperature_c: z.number().nullable(),
        weather_code: z.number().nullable(),
        kind: z.enum(['clear', 'cloud', 'rain', 'snow', 'storm', 'unknown']),
        label: z.string(),
        traffic_multiplier: z.number().min(1),
      })
      .parse(raw);
  }

  /** Runs or reads Router's cached same-snapshot policy comparison. */
  override async getPolicyComparison(): Promise<PolicyComparison> {
    // A cold comparison includes fixed-roster refinement and expanded-workforce
    // covering. Keep its timeout separate from ordinary status requests.
    const raw = await this.fetchJson(
      '/v1/policy-comparison',
      {},
      Math.max(this.options.requestTimeoutMs, 90_000),
    );
    const parsed = policyComparisonSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Router /v1/policy-comparison response is invalid: ${parsed.error.message}`);
    }
    return {
      inputPublicationId: parsed.data.input_publication_id,
      inputHash: parsed.data.input_hash,
      routerContextVersion: parsed.data.router_context_version,
      computedAt: parsed.data.computed_at,
      searchBudgetMs: parsed.data.search_budget_ms,
      rows: parsed.data.rows.map((row) => ({
        strategyId: row.strategy_id,
        kind: row.kind,
        additionalEngineers: row.additional_engineers,
        isUsable: row.is_usable,
        calculationMs: row.calculation_ms,
        metrics: {
          requestsTotal: row.summary.requests_total,
          assignedCount: row.summary.assigned_count,
          unassignedCount: row.summary.unassigned_count,
          urgentTotal: row.summary.urgent_total,
          urgentAssignedCount: row.summary.urgent_assigned_count,
          engineersUsed: row.summary.engineers_used,
          distanceKm: row.summary.distance_km,
          travelTimeSec: row.summary.travel_time_sec,
          workTimeSec: row.summary.work_time_sec,
          waitingTimeSec: row.summary.waiting_time_sec,
          lunchTimeSec: row.summary.lunch_time_sec,
          lateAssignedCount: row.summary.late_assigned_count,
          totalLatenessSec: row.summary.total_lateness_sec,
          minWindowSlackSec: row.summary.min_window_slack_sec,
          workloadSpreadSec: row.summary.workload_spread_sec,
          maxWorkloadSec: row.summary.max_workload_sec,
        },
      })),
    };
  }

  /** A constructed HTTP client always has a configured Router origin. */
  isConfigured(): boolean {
    return true;
  }

  private async fetchJson(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { accept: 'application/json' },
        ...(init.headers
          ? {
              headers: {
                accept: 'application/json',
                ...Object.fromEntries(new Headers(init.headers)),
              },
            }
          : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 409) {
          let detail: unknown = null;
          try {
            detail = ((await response.json()) as { detail?: unknown }).detail ?? null;
          } catch {
            // An invalid conflict body is still a conflict; recovery is to refresh state.
          }
          throw new SysError(
            'VERSION_CONFLICT',
            'Router technical settings changed; refresh and confirm again',
            { details: { routerDetail: detail } },
          );
        }
        throw new Error(`Router ${path} returned HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Router ${path} timed out after ${timeoutMs} ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toTechnicalSettings(
  settings: z.infer<typeof technicalSettingsSchema>,
  routerContextVersion: string,
): RouterTechnicalSettingsState {
  return {
    lunchesEnabled: settings.lunches_enabled,
    departureLatenessToleranceSec: settings.departure_lateness_tolerance_sec,
    taskStartLatenessToleranceSec: settings.task_start_lateness_tolerance_sec,
    ...(settings.window_lateness_tolerance_sec === undefined
      ? {}
      : { windowLatenessToleranceSec: settings.window_lateness_tolerance_sec }),
    ...(settings.traffic_enabled === undefined ? {} : { trafficEnabled: settings.traffic_enabled }),
    ...(settings.equipment_transfers_enabled === undefined
      ? {}
      : { equipmentTransfersEnabled: settings.equipment_transfers_enabled }),
    ...(settings.metro_enabled === undefined ? {} : { metroEnabled: settings.metro_enabled }),
    ...(settings.equipment_enabled === undefined
      ? {}
      : { equipmentEnabled: settings.equipment_enabled }),
    travelTimeMode: settings.travel_time_mode,
    accessBufferSec: settings.access_buffer_sec,
    fixedTravelTimeSec: settings.fixed_travel_time_sec,
    earlyFinishReplanThresholdSec: settings.early_finish_replan_threshold_sec,
    taskOverrunToleranceSec: settings.task_overrun_tolerance_sec,
    routerContextVersion,
  };
}
