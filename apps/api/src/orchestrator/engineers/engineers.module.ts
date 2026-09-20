import { Module } from '@nestjs/common';
import { MountDataEngModule } from '../../routing/mount-data-eng';
import { EngineersService } from './engineers.service';

@Module({
  imports: [MountDataEngModule],
  providers: [EngineersService],
  exports: [EngineersService],
})
export class EngineersModule {}
