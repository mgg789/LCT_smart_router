import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { MiniAiService } from './mini-ai.service';

/**
 * AI contour controls. Calibration never mutates a plan. The mini calls only
 * rephrase a context or pick an id from a server-built list (D-11).
 */
@Module({
  providers: [AiService, MiniAiService],
  exports: [AiService, MiniAiService],
})
export class AiModule {}
