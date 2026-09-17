import { Module } from '@nestjs/common';
import { EngineersService } from './engineers.service';

@Module({
  providers: [EngineersService],
  exports: [EngineersService],
})
export class EngineersModule {}
