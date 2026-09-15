import { Module } from '@nestjs/common';
import { EngineersService } from './engineers.service';
import { GpsService } from './gps.service';

@Module({
  providers: [EngineersService, GpsService],
  exports: [EngineersService, GpsService],
})
export class EngineersModule {}
