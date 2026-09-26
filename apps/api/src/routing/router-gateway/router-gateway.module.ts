import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../common/config';
import { HealthRegistry } from '../../common/health';
import { AlertsModule } from '../../orchestrator/alerts';
import { PrismaService } from '../../persistence';
import { AppliedPlanService } from './applied-plan.service';
import { ControlStateService } from './control-state.service';
import { HttpRouterClient } from './http-router-client';
import { ManualPlanService } from './manual-plan.service';
import { ResultAcceptanceService } from './result-acceptance.service';
import { NullRouterClient, RouterClient } from './router-client.port';
import { RouterHealthProbe } from './router-health.probe';
import { RouterResultCoordinator } from './router-result-coordinator';

/**
 * `ROUTER-gateway` of context/36 section 2: receiving a result, checking that it belongs
 * to the current task, and controlling whether it is applied at all.
 *
 * A configured private Router URL selects the HTTP client; otherwise the truthful null
 * client keeps automatic planning disabled without making sys unready.
 */
@Global()
@Module({
  imports: [AlertsModule],
  providers: [
    {
      provide: RouterClient,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): RouterClient => {
        const baseUrl = config.get('ROUTER_BASE_URL');
        return baseUrl
          ? new HttpRouterClient({
              baseUrl,
              requestTimeoutMs: config.get('ROUTER_REQUEST_TIMEOUT_MS'),
            })
          : new NullRouterClient();
      },
    },
    AppliedPlanService,
    ControlStateService,
    ManualPlanService,
    ResultAcceptanceService,
    {
      provide: RouterResultCoordinator,
      inject: [RouterClient, ResultAcceptanceService, PrismaService, AppConfigService],
      useFactory: (
        client: RouterClient,
        acceptance: ResultAcceptanceService,
        prisma: PrismaService,
        config: AppConfigService,
      ): RouterResultCoordinator =>
        new RouterResultCoordinator(
          client,
          acceptance,
          config.get('ROUTER_POLL_INTERVAL_MS'),
          prisma,
        ),
    },
    RouterHealthProbe,
  ],
  exports: [
    RouterClient,
    AppliedPlanService,
    ControlStateService,
    ManualPlanService,
    ResultAcceptanceService,
    RouterResultCoordinator,
  ],
})
export class RouterGatewayModule implements OnModuleInit {
  constructor(
    private readonly registry: HealthRegistry,
    private readonly probe: RouterHealthProbe,
  ) {}

  onModuleInit(): void {
    this.registry.register('router', this.probe);
  }
}
