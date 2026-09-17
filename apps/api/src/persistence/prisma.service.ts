import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../common/config';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The single database connection of the System Layer.
 *
 * Prisma 7 connects through a driver adapter, so the URL comes from configuration rather
 * than from the schema file. The application connects as the business writer; schema
 * changes run separately under the migration owner, and Router Core gets its own
 * read-only credentials for the published sector (context/43 section 5.1).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      adapter: new PrismaPg({ connectionString: config.get('DATABASE_URL') }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
