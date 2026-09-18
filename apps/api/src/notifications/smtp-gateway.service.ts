import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../common/config';
import { Clock } from '../common/time';
import type { NotificationIntent, NotificationState, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../persistence';
import { renderMail } from './mail-templates';
import { asRecord, redactPayload } from './smtp.helpers';
import {
  createNodemailerTransport,
  type MailTransport,
  type TransportOutcome,
} from './smtp.transport';

export interface MailHealthSnapshot {
  readonly status: 'ok' | 'down' | 'unreachable';
  readonly accessMode: 'VPN_ONLY' | 'VPN_PLUS_DIRECT_TLS' | 'unknown';
  readonly detail?: string;
}

/**
 * SMTP-gateway of context/35: takes a prepared letter and asks the external MTA
 * to accept it. It does not invent a `delivered` state.
 */
@Injectable()
export class SmtpGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmtpGatewayService.name);
  private timer: NodeJS.Timeout | undefined;
  private submitting = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly primaryTransport: MailTransport | null,
    private readonly fallbackTransport: MailTransport | null,
  ) {}

  get configured(): boolean {
    return this.primaryTransport !== null;
  }

  onModuleInit(): void {
    if (!this.configured) {
      return;
    }
    const interval = this.config.get('SMTP_POLL_INTERVAL_MS');
    this.timer = setInterval(() => {
      void this.submitPending();
    }, interval);
    this.timer.unref();
    void this.submitPending();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async submitPending(): Promise<void> {
    if (!this.configured || this.submitting) {
      return;
    }
    this.submitting = true;
    try {
      const now = this.clock.nowSeconds();
      const pending = await this.prisma.notificationIntent.findMany({
        where: { state: 'pending_submission' },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const intent of pending) {
        await this.submitIntent(intent, now);
      }
    } finally {
      this.submitting = false;
    }
  }

  async submitById(id: string): Promise<void> {
    const intent = await this.prisma.notificationIntent.findUnique({ where: { id } });
    if (!intent) {
      return;
    }
    await this.submitIntent(intent, this.clock.nowSeconds());
  }

  async readHealth(): Promise<MailHealthSnapshot> {
    const url = this.config.get('SMTP_HEALTH_URL');
    if (!url) {
      if (!this.primaryTransport) {
        return { status: 'unreachable', accessMode: 'unknown', detail: 'SMTP is not configured' };
      }
      const up = await this.primaryTransport.verify();
      return {
        status: up ? 'ok' : 'down',
        accessMode: 'unknown',
        detail: up ? 'transport verify ok' : 'transport verify failed',
      };
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) {
        return { status: 'down', accessMode: 'unknown', detail: `health http ${response.status}` };
      }
      const body = (await response.json()) as {
        status?: string;
        access_mode?: string;
        accepts_mail?: boolean;
      };
      const accepts = body.accepts_mail !== false && body.status === 'ok';
      const accessMode =
        body.access_mode === 'VPN_PLUS_DIRECT_TLS' || body.access_mode === 'VPN_ONLY'
          ? body.access_mode
          : 'unknown';
      return {
        status: accepts ? 'ok' : 'down',
        accessMode,
        detail: `watchdog ${body.status ?? 'unknown'}`,
      };
    } catch (error) {
      return {
        status: 'unreachable',
        accessMode: 'unknown',
        detail: error instanceof Error ? error.message : 'health unreachable',
      };
    }
  }

  private async submitIntent(intent: NotificationIntent, now: number): Promise<void> {
    if (intent.state !== 'pending_submission' || !this.primaryTransport) {
      return;
    }
    const payload = asRecord(intent.payload);
    const rendered = renderMail(intent.category, payload, {
      appBaseUrl: this.config.get('SMTP_APP_BASE_URL'),
    });
    const transport = await this.chooseTransport();
    const outcome = await transport.send({
      from: this.config.get('SMTP_FROM'),
      to: intent.recipientEmail,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    await this.recordOutcome(intent, now, outcome, redactPayload(payload));
  }

  private async chooseTransport(): Promise<MailTransport> {
    const primary = this.primaryTransport;
    if (!primary) {
      throw new Error('SMTP is not configured');
    }
    if (!this.fallbackTransport) {
      return primary;
    }
    const health = await this.readHealth();
    if (health.accessMode === 'VPN_PLUS_DIRECT_TLS' && health.status !== 'ok') {
      return this.fallbackTransport;
    }
    const primaryUp = await primary.verify();
    if (!primaryUp && health.accessMode === 'VPN_PLUS_DIRECT_TLS') {
      return this.fallbackTransport;
    }
    return primary;
  }

  private async recordOutcome(
    intent: NotificationIntent,
    now: number,
    outcome: TransportOutcome,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const state: NotificationState =
      outcome.kind === 'accepted'
        ? 'accepted_by_server'
        : outcome.kind === 'rejected'
          ? 'rejected'
          : 'submission_unknown';
    // A later heartbeat failure must not rewrite an accepted row. The unique
    // business event already happened; we only store the first decisive result.
    await this.prisma.notificationIntent.updateMany({
      where: { id: intent.id, state: 'pending_submission' },
      data: {
        state,
        submittedAt: BigInt(now),
        error: outcome.kind === 'accepted' ? null : truncate(outcome.response),
        payload: payload as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Mail ${intent.id} ${state}`);
  }
}

function truncate(value: string): string {
  return value.length > 400 ? `${value.slice(0, 397)}...` : value;
}

export function createConfiguredTransports(config: AppConfigService): {
  primary: MailTransport | null;
  fallback: MailTransport | null;
} {
  const host = config.get('SMTP_HOST');
  const user = config.get('SMTP_USER');
  const password = config.get('SMTP_PASSWORD');
  if (!host || !user || !password) {
    return { primary: null, fallback: null };
  }
  const primary = createNodemailerTransport({
    host,
    port: config.get('SMTP_PORT'),
    user,
    password,
  });
  const fallbackHost = config.get('SMTP_FALLBACK_HOST');
  const fallback = fallbackHost
    ? createNodemailerTransport({
        host: fallbackHost,
        port: config.get('SMTP_FALLBACK_PORT'),
        user,
        password,
      })
    : null;
  return { primary, fallback };
}
