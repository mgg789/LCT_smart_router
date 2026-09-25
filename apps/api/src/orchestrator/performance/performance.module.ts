import { Global, Module } from '@nestjs/common';
import { PerformanceService } from './performance.service';

/** Durable dispatcher and engineer day analytics backed by AppState evidence. */
@Global()
@Module({
  providers: [PerformanceService],
  exports: [PerformanceService],
})
export class PerformanceModule {}
