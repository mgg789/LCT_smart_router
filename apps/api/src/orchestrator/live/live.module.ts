import { Module } from '@nestjs/common';
import { MountDataEngModule } from '../../routing/mount-data-eng';
import { RouterGatewayModule } from '../../routing/router-gateway';
import { DemoStandModule } from '../demo-stand';
import { EngineersModule } from '../engineers';
import { FactsModule } from '../facts';
import { RewardsModule } from '../rewards';
import { LiveCoordinator } from './live.coordinator';
import { LiveService } from './live.service';
import { LiveReadProjection } from './live-read-projection';

@Module({
  imports: [
    EngineersModule,
    FactsModule,
    RewardsModule,
    MountDataEngModule,
    RouterGatewayModule,
    DemoStandModule,
  ],
  providers: [LiveService, LiveCoordinator, LiveReadProjection],
  exports: [LiveService, LiveCoordinator],
})
export class LiveModule {}
