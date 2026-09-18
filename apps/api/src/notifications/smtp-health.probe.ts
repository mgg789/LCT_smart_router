import { Injectable } from '@nestjs/common';
import type { HealthProbe, ServiceHealth } from '../common/health';
import { SmtpGatewayService } from './smtp-gateway.service';

/**
 * SMTP is never a required dependency. A dead mail host must not hide the
 * dispatcher's password login (context/43 section 11.3).
 */
@Injectable()
export class SmtpHealthProbe implements HealthProbe {
  readonly required = false;

  constructor(private readonly gateway: SmtpGatewayService) {}

  async check(): Promise<ServiceHealth> {
    if (!this.gateway.configured) {
      return { status: 'not_configured', detail: 'SMTP-gateway has no host configured' };
    }
    const health = await this.gateway.readHealth();
    if (health.status === 'ok') {
      return { status: 'ok', detail: `${health.detail ?? 'up'}; ${health.accessMode}` };
    }
    if (health.status === 'unreachable') {
      return { status: 'down', detail: health.detail ?? 'watchdog unreachable' };
    }
    return { status: 'degraded', detail: health.detail ?? 'mail process not accepting' };
  }
}
