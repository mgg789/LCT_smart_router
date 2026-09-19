import { Injectable, Logger } from '@nestjs/common';
import { RouterClient, type RouterTechnicalSettings } from '../../routing/router-gateway';

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
@Injectable()
export class ExecutionTimingPolicy {
  private readonly logger = new Logger(ExecutionTimingPolicy.name);
  private cached: ExecutionTimingPolicyValue = DEFAULT_EXECUTION_TIMING_POLICY;

  constructor(private readonly router: RouterClient) {}

  /** Returns the current Router-owned thresholds, or the last safe local copy. */
  async read(): Promise<ExecutionTimingPolicyValue> {
    if (!this.router.isConfigured()) {
      return this.cached;
    }
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
    taskOverrunToleranceSec: settings.taskOverrunToleranceSec,
  };
}
