import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthRegistry } from './health.registry';

/**
 * Declares the integrations the design expects, so that `/health/services` tells the
 * truth about this build instead of staying silent about what is missing. Router, SMTP
 * and AI each register their own real probe from their own feature module rather than
 * from here: there is nothing left in this build that is merely declared and not wired.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [HealthRegistry],
  exports: [HealthRegistry],
})
export class HealthModule {}
