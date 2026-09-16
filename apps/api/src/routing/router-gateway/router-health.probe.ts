import { Injectable } from '@nestjs/common';
import type { HealthProbe, ServiceHealth } from '../../common/health';
import { RouterClient } from './router-client.port';

/**
 * Router is never a required dependency.
 *
 * The application takes requests, publishes the task and serves every contour without it;
 * what it cannot do is distribute work automatically. Reporting that honestly beats
 * failing readiness (context/43 section 11.3).
 */
@Injectable()
export class RouterHealthProbe implements HealthProbe {
  readonly required = false;

  constructor(private readonly client: RouterClient) {}

  async check(): Promise<ServiceHealth> {
    if (!this.client.isConfigured()) {
      return { status: 'not_configured', detail: 'Router Core URL is not configured' };
    }
    try {
      const result = await this.client.getResult();
      return { status: 'ok', detail: `last status: ${result.status}` };
    } catch (error) {
      return {
        status: 'down',
        detail: error instanceof Error ? error.message : 'router unreachable',
      };
    }
  }
}
