import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry } from '../common/health';
import { BootstrapService } from './bootstrap.service';
import { DatabaseHealthProbe } from './database-health.probe';
import { PrismaService } from './prisma.service';
import { UnitOfWork } from './unit-of-work';

/**
 * `dataengine` of context/36 section 2: reading and writing business data, history and
 * operation results, with consistent commit boundaries and version checks.
 *
 * Repositories are not defined here. Each feature module owns the queries it needs, so
 * that a generic data-access layer does not grow ahead of any caller.
 */
@Global()
@Module({
  providers: [PrismaService, UnitOfWork, DatabaseHealthProbe, BootstrapService],
  exports: [PrismaService, UnitOfWork],
})
export class PersistenceModule implements OnModuleInit {
  constructor(
    private readonly registry: HealthRegistry,
    private readonly probe: DatabaseHealthProbe,
  ) {}

  onModuleInit(): void {
    this.registry.register('database', this.probe);
  }
}
