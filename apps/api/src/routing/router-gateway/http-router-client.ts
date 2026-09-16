import { z } from 'zod';
import type { RouterResult } from './result.types';
import { routerResultSchema } from './result.types';
import { RouterClient } from './router-client.port';

const routerContextSchema = z.looseObject({
  router_context_version: z.string().min(1).nullable(),
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

  /** A constructed HTTP client always has a configured Router origin. */
  isConfigured(): boolean {
    return true;
  }

  private async fetchJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    timeout.unref();
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
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
