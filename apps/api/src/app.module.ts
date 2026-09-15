import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AppConfigModule } from './common/config';
import { HealthModule } from './common/health';
import { RequestContextMiddleware } from './common/logging';
import { TimeModule } from './common/time';

/**
 * Root of the System Layer.
 *
 * The eight internal blocks of context/36 section 2 (REST API, auth-engine, dataengine,
 * orchestrator backend, mount-data-eng, ROUTER-gateway, AI-gateway, SMTP-gateway) are
 * modules of this one application, not one service each.
 */
@Module({
  imports: [AppConfigModule, TimeModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*splat');
  }
}
