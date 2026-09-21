import { Module } from '@nestjs/common';
import { MountDataEngModule } from '../../routing/mount-data-eng';
import { RouterGatewayModule } from '../../routing/router-gateway';
import { DemoStandModule } from '../demo-stand';
import { EngineersModule } from '../engineers';
import { FactsModule } from '../facts';
import { LiveCoordinator } from './live.coordinator';
import { LiveService } from './live.service';

@Module({
  imports: [EngineersModule, FactsModule, MountDataEngModule, RouterGatewayModule, DemoStandModule],
  providers: [LiveService, LiveCoordinator],
  exports: [LiveService, LiveCoordinator],
})
export class LiveModule {}
