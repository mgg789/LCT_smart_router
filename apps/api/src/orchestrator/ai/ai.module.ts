import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { MiniAiService } from './mini-ai.service';
import { WeatherDayCacheService } from './weather-day-cache.service';

/**
 * AI contour controls. Calibration never mutates a plan. The mini calls only
 * rephrase a context or pick an id from a server-built list (D-11).
 *
 * Global so that `AlertsService` can run the System one alert resolution without
 * importing this module: `RouterGatewayModule` already imports `AlertsModule`, and an
 * extra edge `AlertsModule → AiModule` would close a provider cycle through the global
 * `RouterClient`.
 */
@Global()
@Module({
  providers: [AiService, MiniAiService, WeatherDayCacheService],
  exports: [AiService, MiniAiService],
})
export class AiModule {}
