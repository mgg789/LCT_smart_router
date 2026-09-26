import { Injectable, Logger } from '@nestjs/common';
import {
  RouterClient,
  type RouterTechnicalSettings,
} from '../../routing/router-gateway/router-client.port';

/** Thresholds that turn confirmed execution variance into a new routing task. */
export interface ExecutionTimingPolicyValue {
  readonly earlyFinishReplanThresholdSec: number;
  readonly taskOverrunToleranceSec: number;
}

export const DEFAULT_EXECUTION_TIMING_POLICY: ExecutionTimingPolicyValue = {
  earlyFinishReplanThresholdSec: 15 * 60,
  taskOverrunToleranceSec: 10 * 60,
};

/**
 * Reads execution thresholds from Router without making fact recording depend on Router
 * uptime. The last validated value is retained; defaults are used only before the first
 * successful read or when Router is intentionally disabled.
 */
const SETTINGS_TTL_MS = 30_000;

@Injectable()
export class ExecutionTimingPolicy {
  private readonly logger = new Logger(ExecutionTimingPolicy.name);
  private cached: ExecutionTimingPolicyValue = DEFAULT_EXECUTION_TIMING_POLICY;
  private refreshedAt = 0;
  private inFlight: Promise<ExecutionTimingPolicyValue> | null = null;

  constructor(private readonly router: RouterClient) {}

  /**
   * Returns the last safe thresholds immediately.
   *
   * LIVE calls this on every clock tick. Waiting here for Router put the tick,
   * and every screen waiting on that tick, behind a solve. A refresh runs beside
   * the tick and replaces the cache when it returns.
   */
  read(): Promise<ExecutionTimingPolicyValue> {
    if (this.router.isConfigured() && Date.now() - this.refreshedAt >= SETTINGS_TTL_MS) {
      if (!this.inFlight) {
        const pending = this.refresh().finally(() => {
          if (this.inFlight === pending) this.inFlight = null;
        });
        this.inFlight = pending;
      }
    }
    return Promise.resolve(this.cached);
  }

  private async refresh(): Promise<ExecutionTimingPolicyValue> {
    try {
      const settings = await this.router.getTechnicalSettings();
      this.cached = fromRouterSettings(settings);
    } catch (error) {
      this.logger.warn(
        `Could not refresh execution thresholds; using the last validated value: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    this.refreshedAt = Date.now();
    return this.cached;
  }

  /** Last validated Router policy, safe inside an already-open DB transaction. */
  current(): ExecutionTimingPolicyValue {
    return this.cached;
  }
}

function fromRouterSettings(settings: RouterTechnicalSettings): ExecutionTimingPolicyValue {
  return {
    earlyFinishReplanThresholdSec: settings.earlyFinishReplanThresholdSec,
    taskOverrunToleranceSec: settings.strictTimeWindows ? 0 : settings.taskOverrunToleranceSec,
  };
}
