import { Global, Module } from '@nestjs/common';
import { GeocodingService } from './geocoding.service';
import { MapRoutingService } from './map-routing.service';
import { DispatcherSettingsService } from './dispatcher-settings.service';

/** Dispatcher operational settings, LocationIQ geocoding and map-provider routing. */
@Global()
@Module({
  providers: [DispatcherSettingsService, GeocodingService, MapRoutingService],
  exports: [DispatcherSettingsService, GeocodingService, MapRoutingService],
})
export class DispatcherSettingsModule {}
