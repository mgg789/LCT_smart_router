import { Global, Module } from '@nestjs/common';
import { AlertCoordinator } from './alert-coordinator';
import { AlertsService } from './alerts.service';

/** Dispatcher decisions, their suppression rules and day-close gate. */
@Global()
@Module({
  providers: [AlertsService, AlertCoordinator],
  exports: [AlertsService, AlertCoordinator],
})
export class AlertsModule {}
