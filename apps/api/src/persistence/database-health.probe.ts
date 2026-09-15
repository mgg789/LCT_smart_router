import { Injectable } from '@nestjs/common';
import type { HealthProbe, ServiceHealth } from '../common/health';
import { PrismaService } from './prisma.service';

/**
 * The database is the one dependency the application genuinely cannot serve without, so
 * this is the only probe registered as required.
 */
@Injectable()
export class DatabaseHealthProbe implements HealthProbe {
  readonly required = true;

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<ServiceHealth> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (error) {
      return {
        status: 'down',
        // The message is a connection diagnostic, not a credential: PrismaService never
        // puts the URL into an error it re-throws.
        detail: error instanceof Error ? error.message : 'database unreachable',
      };
    }
  }
}
