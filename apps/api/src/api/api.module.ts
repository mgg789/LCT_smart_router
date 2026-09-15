import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';

/**
 * `REST API` of context/36 section 2: the four external contours reach the system through
 * controllers here.
 *
 * Controllers translate HTTP into system operations and back. They hold no business
 * rules: a rule lives in exactly one handler, and the UI, the integration API and an AI
 * tool must not grow three diverging versions of it (context/36 section 2).
 */
@Module({
  controllers: [AuthController],
})
export class ApiModule {}
