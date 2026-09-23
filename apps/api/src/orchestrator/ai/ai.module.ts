import { Module } from '@nestjs/common';
import { AiService } from './ai.service';

/**
 * AI contour controls. The service only reads facts and pushes calibration into
 * Router; it never decides or mutates a plan (context/08, D-11).
 */
@Module({
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
