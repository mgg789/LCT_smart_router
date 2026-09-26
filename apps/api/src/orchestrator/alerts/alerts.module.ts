import { Global, Module } from '@nestjs/common';
import { AlertCoordinator } from './alert-coordinator';
import { AlertWindowQuery } from './alert-window-query';
import { AlertsService } from './alerts.service';

/**
 * Dispatcher decisions, their suppression rules and day-close gate.
 *
 * No imports on purpose: `AiModule` and `OperationsModule` are global, and a direct
 * `AlertsModule → AiModule` edge would close a cycle through `RouterGatewayModule →
 * AlertsModule` and the global `RouterClient` that `AiService` consumes.
 */
@Global()
@Module({
  providers: [AlertsService, AlertCoordinator, AlertWindowQuery],
  exports: [AlertsService, AlertCoordinator],
})
export class AlertsModule {}
