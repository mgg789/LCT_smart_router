import { Module } from '@nestjs/common';
import { MountDataEngModule } from '../../routing/mount-data-eng';
import { RouterGatewayModule } from '../../routing/router-gateway';
import { DemoStandModule } from '../demo-stand';
import { EngineersModule } from '../engineers';
import { FactsModule } from '../facts';
import { RewardsModule } from '../rewards';
import { LiveCoordinator } from './live.coordinator';
import { LiveService } from './live.service';
import { LiveDayState } from './live-day-state';
import { LiveReadProjection } from './live-read-projection';
import { LiveRouteQuery } from './live-route-query';

@Module({
  imports: [
    EngineersModule,
    FactsModule,
    RewardsModule,
    MountDataEngModule,
    RouterGatewayModule,
    DemoStandModule,
  ],
  providers: [LiveService, LiveCoordinator, LiveReadProjection, LiveDayState, LiveRouteQuery],
  exports: [LiveService, LiveCoordinator],
})
export class LiveModule {}
