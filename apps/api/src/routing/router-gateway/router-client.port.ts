import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import type { RouterResult } from './result.types';

export interface RouterTechnicalSettings {
  readonly lunchesEnabled: boolean;
  readonly departureLatenessToleranceSec: number;
  readonly taskStartLatenessToleranceSec: number;
  /** Allowed lateness measured against the customer's original service window. */
  readonly windowLatenessToleranceSec?: number;
  /** Whether Router may use traffic-aware travel times. */
  readonly trafficEnabled?: boolean;
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
  /** The current result, whatever its status. */
  abstract getResult(): Promise<RouterResult>;

  /**
   * The context version in force **now**.
   *
   * Read separately from any result package on purpose: a result cannot report its own
   * currency, and an answer computed before a map change must not be marked with the new
   * version (context/33 section 7).
   */
  abstract getActiveContextVersion(): Promise<string | null>;

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

  abstract isConfigured(): boolean;
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
