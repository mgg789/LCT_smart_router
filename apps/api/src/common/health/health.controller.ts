import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthRegistry } from './health.registry';
import type { ServiceHealth } from './health.types';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly registry: HealthRegistry) {}

  @Get('live')
  @ApiOperation({ summary: 'Process is up and the event loop answers' })
  live(): { status: 'ok'; uptimeSec: number } {
    return { status: 'ok', uptimeSec: Math.floor(process.uptime()) };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Required dependencies are usable' })
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: 'ok' | 'down'; checks: Record<string, ServiceHealth> }> {
    const checks = await this.registry.checkRequired();
    const down = Object.values(checks).some((check) => check.status === 'down');
    res.status(down ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);
    return { status: down ? 'down' : 'ok', checks };
  }

  @Get('services')
  @ApiOperation({
    summary: 'Per-service status, including integrations that are not wired yet',
  })
  async services(): Promise<{ services: Record<string, ServiceHealth> }> {
    return { services: await this.registry.checkAll() };
  }
}
