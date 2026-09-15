import { Module } from '@nestjs/common';
import { EngineersModule } from '../orchestrator/engineers';
import { FactsModule } from '../orchestrator/facts';
import { RequestsModule } from '../orchestrator/requests';
import { AuthController } from './auth.controller';
import { ClientController } from './client.controller';
import { DispatchController } from './dispatch.controller';
import { EngineerController } from './engineer.controller';

/**
 * `REST API` of context/36 section 2: the four external contours reach the system through
 * controllers here.
 *
 * Controllers translate HTTP into system operations and back. They hold no business
 * rules: a rule lives in exactly one handler, so the UI, the integration API and an AI
 * tool cannot grow three diverging versions of it (context/36 section 2).
 */
@Module({
  imports: [RequestsModule, EngineersModule, FactsModule],
  controllers: [AuthController, ClientController, EngineerController, DispatchController],
})
export class ApiModule {}
