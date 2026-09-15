import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../../common/health';
import { AppliedPlanService } from './applied-plan.service';
import { ControlStateService } from './control-state.service';
import { ManualPlanService } from './manual-plan.service';
import { ResultAcceptanceService } from './result-acceptance.service';
import { NullRouterClient, RouterClient } from './router-client.port';
import { RouterHealthProbe } from './router-health.probe';

/**
 * `ROUTER-gateway` of context/36 section 2: receiving a result, checking that it belongs
 * to the current task, and controlling whether it is applied at all.
 *
 * The client is bound to the null implementation because Router Core is not wired yet.
 * Swapping in an HTTP client is a one-line provider change; nothing else in the module
 * knows how the result arrives.
 */
@Global()
@Module({
  providers: [
    { provide: RouterClient, useClass: NullRouterClient },
    AppliedPlanService,
    ControlStateService,
    ManualPlanService,
    ResultAcceptanceService,
    RouterHealthProbe,
  ],
  exports: [
    RouterClient,
    AppliedPlanService,
    ControlStateService,
    ManualPlanService,
    ResultAcceptanceService,
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
