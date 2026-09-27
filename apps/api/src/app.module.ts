import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AiModule as AiGatewayModule } from './ai';
import { ApiModule } from './api/api.module';
import { AuthModule } from './auth';
import { AppConfigModule } from './common/config';
import { HealthModule } from './common/health';
import { RequestContextMiddleware } from './common/logging';
import { ObservabilityModule } from './common/observability/observability.module';
import { TimeModule } from './common/time';
import { NotificationsModule } from './notifications';
import { OperationsModule } from './operations';
import { AlertsModule } from './orchestrator/alerts';
import { EngineersModule } from './orchestrator/engineers';
import { FactsModule } from './orchestrator/facts';
import { ImportsModule } from './orchestrator/imports';
import { LiveModule } from './orchestrator/live';
import { McpModule } from './orchestrator/mcp';
import { PassportsModule } from './orchestrator/passports';
import { PolicyModule } from './orchestrator/policy';
import { RequestsModule } from './orchestrator/requests';
import { ResetModule } from './orchestrator/reset';
import { DispatcherSettingsModule } from './orchestrator/settings';
import { PersistenceModule } from './persistence';
import { MountDataEngModule } from './routing/mount-data-eng';
import { RouterGatewayModule } from './routing/router-gateway';

/**
 * Root of the System Layer.
 *
 * The eight internal blocks of context/36 section 2 (REST API, auth-engine, dataengine,
 * orchestrator backend, mount-data-eng, ROUTER-gateway, AI-gateway, SMTP-gateway) are
 * modules of this one application, not one service each.
 */
@Module({
  imports: [
    AppConfigModule,
    ObservabilityModule,
    TimeModule,
    HealthModule,
    PersistenceModule,
    AuthModule,
    OperationsModule,
    NotificationsModule,
    MountDataEngModule,
    RouterGatewayModule,
    PolicyModule,
    PassportsModule,
    DispatcherSettingsModule,
    RequestsModule,
    EngineersModule,
    AlertsModule,
    FactsModule,
    ImportsModule,
    ResetModule,
    LiveModule,
    McpModule,
    AiGatewayModule,
    ApiModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*splat');
  }
}
