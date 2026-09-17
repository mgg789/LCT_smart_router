import { Module } from '@nestjs/common';
import { RouterGatewayModule } from '../../routing/router-gateway';
import { ExecutionOverrunCoordinator } from './execution-overrun-coordinator';
import { ExecutionTimingPolicy } from './execution-timing-policy';
import { FactsService } from './facts.service';

@Module({
  imports: [RouterGatewayModule],
  providers: [FactsService, ExecutionTimingPolicy, ExecutionOverrunCoordinator],
  exports: [FactsService, ExecutionTimingPolicy, ExecutionOverrunCoordinator],
})
export class FactsModule {}
