import { z } from 'zod';
import { SysError } from '../../common/errors';
import type { RouterResult } from './result.types';
import { routerResultSchema } from './result.types';
import {
  RouterClient,
  type RouterTechnicalSettingsState,
  type RouterTechnicalSettingsUpdate,
  type UpdateRouterTechnicalSettings,
} from './router-client.port';

const technicalSettingsSchema = z.object({
  lunches_enabled: z.boolean(),
  departure_lateness_tolerance_sec: z.number().int().nonnegative().max(86_400),
  task_start_lateness_tolerance_sec: z.number().int().nonnegative().max(86_400),
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
  private readonly baseUrl: string;

  constructor(private readonly options: HttpRouterClientOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
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

  /** Reads and validates the complete active technical settings revision. */
  override async getTechnicalSettings(): Promise<RouterTechnicalSettingsState> {
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
    return {
      operationId: parsed.data.operation_id,
      status: parsed.data.status,
      ...toTechnicalSettings(parsed.data.technical_settings, parsed.data.router_context_version),
    };
  }

  /** A constructed HTTP client always has a configured Router origin. */
  isConfigured(): boolean {
    return true;
  }

  private async fetchJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
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
        throw new Error(`Router ${path} timed out after ${this.options.requestTimeoutMs} ms`, {
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
    travelTimeMode: settings.travel_time_mode,
    accessBufferSec: settings.access_buffer_sec,
    fixedTravelTimeSec: settings.fixed_travel_time_sec,
    earlyFinishReplanThresholdSec: settings.early_finish_replan_threshold_sec,
    taskOverrunToleranceSec: settings.task_overrun_tolerance_sec,
    routerContextVersion,
  };
}
