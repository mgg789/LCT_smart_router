import { Module } from '@nestjs/common';
import { ImportsModule } from '../imports';
import { ResetModule } from '../reset';
import { DemoStandService } from './demo-stand.service';

@Module({
  imports: [ResetModule, ImportsModule],
  providers: [DemoStandService],
  exports: [DemoStandService],
})
export class DemoStandModule {}
