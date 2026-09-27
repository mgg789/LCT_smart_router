import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { AppConfigService } from '../common/config';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { EngineersService, workDateOf } from '../orchestrator/engineers';
import { LiveService } from '../orchestrator/live';
import { DispatcherSettingsService, moscowMinutesToUnix } from '../orchestrator/settings';
import { PrismaService } from '../persistence';
import {
  type ArchiveEngineerDto,
  archiveEngineerSchema,
  type ChangeEngineerEmailDto,
  type CreateEngineerDto,
  changeEngineerEmailSchema,
  createEngineerSchema,
  type LinkEngineerAccountDto,
  linkEngineerAccountSchema,
  operationOnlySchema,
  type SetAvailabilityDto,
  type SetWorkdayDto,
  setAvailabilitySchema,
  setWorkdaySchema,
  type UnlinkEngineerAccountDto,
  type UpdateEngineerDto,
  unlinkEngineerAccountSchema,
  updateEngineerSchema,
} from './dto/engineer.dto';
import {
  type EngineerDayView,
  type EngineerView,
  toDayView,
  toEngineerView,
} from './engineer-view';

/** Dispatcher engineer profile, workday and LIVE availability endpoints. */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchEngineersController {
  constructor(
    private readonly engineers: EngineersService,
    private readonly operations: OperationsService,
    private readonly dispatcherSettings: DispatcherSettingsService,
    private readonly config: AppConfigService,
    private readonly live: LiveService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('engineers')
  @ApiOperation({ summary: 'Engineers with their skills, transport and current day' })
  async listEngineers(): Promise<{
    engineers: Array<EngineerView & { day: EngineerDayView | null }>;
  }> {
    const engineers = await this.prisma.engineer.findMany({
      where: { archivedAt: null },
      orderBy: { inputOrder: 'asc' },
      include: {
        account: { select: { email: true } },
        days: { orderBy: { workDate: 'desc' }, take: 1 },
      },
    });
    return {
      engineers: engineers.map((engineer) => ({
        ...toEngineerView(engineer),
        day: engineer.days[0] ? toDayView(engineer.days[0]) : null,
      })),
    };
  }

  @Post('engineers')
  @ApiOperation({ summary: 'Add an engineer profile, optionally with a login address' })
  async createEngineer(
    @CurrentActor() actor: Actor,
    @Body(zodBody(createEngineerSchema)) dto: CreateEngineerDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'engineer.create', payload: dto },
      async (context) => {
        const created = await this.engineers.create(context, {
          email: dto.email ?? null,
          displayName: dto.displayName,
          skills: dto.skills,
          transportType: dto.transportType,
          region: dto.region ?? null,
          homeLat: dto.homeLat ?? null,
          homeLon: dto.homeLon ?? null,
        });
        const settings = await this.dispatcherSettings.read(context.tx);
        const workDate = workDateOf(context.now, this.config.get('APP_TIME_ZONE'));
        await this.engineers.setWorkday(context, created.id, {
          workDate,
          shiftStartAt: moscowMinutesToUnix(workDate, settings.dayStartMin),
          shiftEndAt: moscowMinutesToUnix(workDate, settings.dayEndMin),
        });
        return toEngineerView(created);
      },
    );
    return { engineer: outcome.result };
  }

  @Delete('engineers/:id')
  @ApiOperation({ summary: 'Archive an engineer profile and revoke its login' })
  async archiveEngineer(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(archiveEngineerSchema)) dto: ArchiveEngineerDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.archive',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toEngineerView(await this.engineers.archive(context, id, dto.expectedVersion ?? null)),
    );
    return { engineer: outcome.result };
  }

  @Post('engineers/link-account')
  @ApiOperation({ summary: 'Give an engineer profile that has no login its email address' })
  async linkEngineerAccount(
    @CurrentActor() actor: Actor,
    @Body(zodBody(linkEngineerAccountSchema)) dto: LinkEngineerAccountDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.link_account',
        targetRef: dto.engineerId,
        payload: dto,
      },
      async (context) =>
        toEngineerView(await this.engineers.linkAccount(context, dto.engineerId, dto.email)),
      { isolated: true },
    );
    return { engineer: outcome.result };
  }

  @Put('engineers/:id/email')
  @ApiOperation({ summary: 'Replace the login address of an engineer profile' })
  async changeEngineerEmail(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(changeEngineerEmailSchema)) dto: ChangeEngineerEmailDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.change_email',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toEngineerView(
          await this.engineers.changeEmail(context, id, dto.expectedVersion ?? null, dto.email),
        ),
      { isolated: true },
    );
    return { engineer: outcome.result };
  }

  @Post('engineers/unlink-account')
  @ApiOperation({ summary: 'Remove the login from an engineer without deleting the profile' })
  async unlinkEngineerAccount(
    @CurrentActor() actor: Actor,
    @Body(zodBody(unlinkEngineerAccountSchema)) dto: UnlinkEngineerAccountDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.unlink_account',
        targetRef: dto.engineerId,
        payload: dto,
      },
      async (context) =>
        toEngineerView(await this.engineers.unlinkAccount(context, dto.engineerId)),
      { isolated: true },
    );
    return { engineer: outcome.result };
  }

  @Patch('engineers/:id')
  @ApiOperation({ summary: 'Change the profile of an engineer' })
  async updateEngineer(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(updateEngineerSchema)) dto: UpdateEngineerDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.update_profile',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toEngineerView(
          await this.engineers.updateProfile(context, id, dto.expectedVersion ?? null, {
            ...(dto.displayName === undefined ? {} : { displayName: dto.displayName }),
            ...(dto.skills === undefined ? {} : { skills: dto.skills }),
            ...(dto.transportType === undefined ? {} : { transportType: dto.transportType }),
            ...(dto.region === undefined ? {} : { region: dto.region }),
            ...(dto.homeLat === undefined ? {} : { homeLat: dto.homeLat }),
            ...(dto.homeLon === undefined ? {} : { homeLon: dto.homeLon }),
          }),
        ),
    );
    return { engineer: outcome.result };
  }

  @Post('engineers/:id/workday')
  @ApiOperation({ summary: 'Set the shift and lunch conditions of one working day' })
  async setWorkday(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(setWorkdaySchema)) dto: SetWorkdayDto,
  ): Promise<{ day: EngineerDayView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.set_workday',
        targetRef: id,
        payload: dto,
      },
      async (context) =>
        toDayView(
          await this.engineers.setWorkday(context, id, {
            workDate: dto.workDate,
            shiftStartAt: dto.shiftStartAt,
            shiftEndAt: dto.shiftEndAt,
            ...(dto.lunch === undefined ? {} : { lunch: dto.lunch }),
            ...(dto.lunchRequired === undefined ? {} : { lunchRequired: dto.lunchRequired }),
            ...(dto.attendanceOptOut === undefined
              ? {}
              : { attendanceOptOut: dto.attendanceOptOut }),
          }),
        ),
    );
    return { day: outcome.result };
  }

  @Post('engineers/:id/availability')
  @ApiOperation({ summary: 'Take an engineer off the line, or put them back on' })
  async setEngineerAvailability(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(setAvailabilitySchema)) dto: SetAvailabilityDto,
  ): Promise<{
    day: EngineerDayView;
    publication: { publicationId: string; inputHash: string; planningAsOf: number } | null;
  }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.set_availability',
        targetRef: id,
        payload: dto,
      },
      async (context) =>
        toDayView(
          await this.live.setDispatcherAvailability(
            context,
            id,
            dto.availability,
            dto.expectedOnlineAt ?? null,
          ),
        ),
    );
    const current = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    return {
      day: outcome.result,
      publication: current
        ? {
            publicationId: current.snapshot.id,
            inputHash: current.snapshot.inputHash,
            planningAsOf: Number(current.snapshot.planningAsOf),
          }
        : null,
    };
  }

  @Post('engineers/:id/technical-break')
  @ApiOperation({ summary: 'Take an engineer off the line for a 15-minute technical stop' })
  async startEngineerTechnicalBreak(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(operationOnlySchema)) dto: { operationId: string },
  ): Promise<{ day: EngineerDayView }> {
    await this.live.assertLegacyMutationAllowed();
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.technical_break',
        targetRef: id,
        payload: dto,
      },
      async (context) => toDayView(await this.engineers.startTechnicalBreak(context, id)),
    );
    return { day: outcome.result };
  }
}
