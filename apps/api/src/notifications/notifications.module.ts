import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../common/config';
import { HealthRegistry } from '../common/health';
import { Clock } from '../common/time';
import { PrismaService } from '../persistence';
import { NotificationsService } from './notifications.service';
import { SmtpGatewayService, createConfiguredTransports } from './smtp-gateway.service';
import { SmtpHealthProbe } from './smtp-health.probe';

/**
 * Mail intents and the SMTP-gateway that submits them.
 *
 * Transport is optional: without SMTP_* the probe stays `not_configured` and the
 * dispatcher password path is unaffected.
 */
@Global()
@Module({
  providers: [
    NotificationsService,
    {
      provide: SmtpGatewayService,
      inject: [AppConfigService, PrismaService, Clock],
      useFactory: (
        config: AppConfigService,
        prisma: PrismaService,
        clock: Clock,
      ): SmtpGatewayService => {
        const transports = createConfiguredTransports(config);
        return new SmtpGatewayService(config, prisma, clock, transports.primary, transports.fallback);
      },
    },
    SmtpHealthProbe,
  ],
  exports: [NotificationsService, SmtpGatewayService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly registry: HealthRegistry,
    private readonly probe: SmtpHealthProbe,
  ) {}

  onModuleInit(): void {
    this.registry.register('smtp', this.probe);
  }
}
