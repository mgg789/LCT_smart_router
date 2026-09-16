import { Injectable, Logger } from '@nestjs/common';
import type { RouterResult } from './result.types';

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

  isConfigured(): boolean {
    return false;
  }
}
