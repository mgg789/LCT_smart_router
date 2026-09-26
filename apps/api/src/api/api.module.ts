import { Module } from '@nestjs/common';
import { AlertResolverModule } from '../ai/alerts';
import { ExplainModule } from '../ai/explain';
import { MonthlyReportsModule } from '../notifications/monthly-reports.module';
import { AiModule } from '../orchestrator/ai';
import { AlertsModule } from '../orchestrator/alerts';
import { DemoStandModule } from '../orchestrator/demo-stand';
import { EngineersModule } from '../orchestrator/engineers';
import { FactsModule } from '../orchestrator/facts';
import { ImportsModule } from '../orchestrator/imports';
import { LiveModule } from '../orchestrator/live';
import { PerformanceModule } from '../orchestrator/performance';
import { RequestsModule } from '../orchestrator/requests';
import { ResetModule } from '../orchestrator/reset';
import { RewardsModule } from '../orchestrator/rewards';
import { RoadImportModule } from '../orchestrator/road-import';
import { AiController } from './ai.controller';
import { AuthController } from './auth.controller';
import { ClientController } from './client.controller';
import { DispatchController } from './dispatch.controller';
import { DispatchChatsController } from './dispatch-chats.controller';
import { EngineerController } from './engineer.controller';
import { MonthlyReportsController } from './monthly-reports.controller';
import {
  DispatchPerformanceController,
  EngineerPerformanceController,
} from './performance.controller';
import { RewardsController } from './rewards.controller';

/**
 * `REST API` of context/36 section 2: the four external contours reach the system through
 * controllers here.
 *
 * Controllers translate HTTP into system operations and back. They hold no business
 * rules: a rule lives in exactly one handler, so the UI, the integration API and an AI
 * tool cannot grow three diverging versions of it (context/36 section 2).
 */
@Module({
  imports: [
    RequestsModule,
    EngineersModule,
    AiModule,
    AlertsModule,
    FactsModule,
    ImportsModule,
    ResetModule,
    DemoStandModule,
    LiveModule,
    RewardsModule,
    PerformanceModule,
    MonthlyReportsModule,
    RoadImportModule,
    ExplainModule,
    AlertResolverModule,
  ],
  controllers: [
    AuthController,
    AiController,
    DispatchChatsController,
    ClientController,
    EngineerController,
    DispatchController,
    RewardsController,
    DispatchPerformanceController,
    EngineerPerformanceController,
    MonthlyReportsController,
  ],
})
export class ApiModule {}
