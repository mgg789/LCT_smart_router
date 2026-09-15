import { Module } from '@nestjs/common';
import { RouterGatewayModule } from '../../routing/router-gateway';
import { FactsService } from './facts.service';

@Module({
  imports: [RouterGatewayModule],
  providers: [FactsService],
  exports: [FactsService],
})
export class FactsModule {}
