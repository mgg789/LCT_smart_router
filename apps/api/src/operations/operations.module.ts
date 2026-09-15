import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { OperationsService } from './operations.service';

/**
 * The operation envelope every change goes through.
 *
 * Global because the rule is not optional: there is no second way to write business data,
 * so every feature module reaches the same idempotency, version and journal guarantees
 * without arranging for them.
 */
@Global()
@Module({
  providers: [OperationsService, AuditService],
  exports: [OperationsService, AuditService],
})
export class OperationsModule {}
