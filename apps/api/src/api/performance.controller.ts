import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { PerformanceService } from '../orchestrator/performance';
import { PrismaService } from '../persistence';

function requiredWorkdayId(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw SysError.validationFailed('workdayId is required', { workdayId: 'required' });
  }
  return value;
}

/** Dispatcher read endpoint for the immutable day performance contract. */
@Roles('dispatcher')
@ApiTags('performance')
@Controller('dispatch/performance')
export class DispatchPerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Get('day')
  @ApiQuery({ name: 'workdayId', required: true, schema: { type: 'string' } })
  @ApiOperation({ summary: 'Dispatcher performance for one LIVE workday' })
  async day(@Query('workdayId') workdayId?: string) {
    return this.performance.day(requiredWorkdayId(workdayId));
  }
}

/** Engineer read endpoint. A session is always restricted to its own linked profile. */
@Roles('engineer')
@ApiTags('performance')
@Controller('engineer/performance')
export class EngineerPerformanceController {
  constructor(
    private readonly performance: PerformanceService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('day')
  @ApiQuery({ name: 'workdayId', required: true, schema: { type: 'string' } })
  @ApiOperation({ summary: 'Own engineer performance for one LIVE workday' })
  async day(
    @CurrentActor() actor: Actor,
    @Query('workdayId') workdayId?: string,
    @Query('engineerId') engineerId?: string,
  ) {
    const subject = actor.accountId
      ? await this.prisma.engineer.findUnique({
          where: { accountId: actor.accountId },
          select: { id: true },
        })
      : engineerId
        ? await this.prisma.engineer.findUnique({ where: { id: engineerId }, select: { id: true } })
        : null;
    if (!subject) throw SysError.forbidden('The authenticated actor has no engineer profile');
    return this.performance.engineerDay(requiredWorkdayId(workdayId), subject.id);
  }
}
