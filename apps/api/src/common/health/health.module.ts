import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthRegistry } from './health.registry';

/**
 * Declares the integrations the design expects, so that `/health/services` tells the
 * truth about this build instead of staying silent about what is missing. A branch that
 * implements one of them registers a real probe under the same name.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [HealthRegistry],
  exports: [HealthRegistry],
})
export class HealthModule implements OnModuleInit {
  constructor(private readonly registry: HealthRegistry) {}

  onModuleInit(): void {
    this.registry.registerNotConfigured('router', 'Router Core client is not wired yet');
    this.registry.registerNotConfigured('ai', 'AI-gateway is out of scope of this build');
    this.registry.registerNotConfigured('smtp', 'SMTP-gateway is out of scope of this build');
  }
}
