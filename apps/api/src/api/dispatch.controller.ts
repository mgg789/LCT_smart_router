import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { EngineersService } from '../orchestrator/engineers';
import { RequestsService } from '../orchestrator/requests';
import { PrismaService } from '../persistence';
import {
  type CreateEngineerDto,
  createEngineerSchema,
  type SetAvailabilityDto,
  type SetWorkdayDto,
  setAvailabilitySchema,
  setWorkdaySchema,
  type UpdateEngineerDto,
  updateEngineerSchema,
} from './dto/engineer.dto';
import {
  type CancelRequestDto,
  cancelRequestSchema,
  type DispatcherCreateRequestDto,
  type DispatcherUpdateRequestDto,
  dispatcherCreateRequestSchema,
  dispatcherUpdateRequestSchema,
} from './dto/request.dto';
import {
  type EngineerDayView,
  type EngineerView,
  toDayView,
  toEngineerView,
} from './engineer-view';
import { type RequestView, toRequestView } from './request-view';

/**
 * Dashboard contour.
 *
 * The dispatcher edits the conditions of the task and the data behind it. In AUTO that is
 * never a direct write of an assignment: changing a condition forms a new planning task,
 * and Router discovers it on its own (context/32 section 6.3).
 */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchController {
  constructor(
    private readonly requests: RequestsService,
    private readonly engineers: EngineersService,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  @Get('requests')
  @ApiOperation({ summary: 'Requests of the day, including started, finished and cancelled' })
  async list(
    @Query('lifecycle') lifecycle?: string,
    @Query('assignment') assignment?: string,
  ): Promise<{ requests: RequestView[] }> {
    const requests = await this.prisma.request.findMany({
      // Unlike the customer's list, this one keeps completed and cancelled work: the
      // dispatcher needs the whole day, not only what is still open (context/39 DB1).
      where: {
        ...(lifecycle ? { lifecycle: lifecycle as never } : {}),
        ...(assignment ? { assignmentState: assignment as never } : {}),
      },
      orderBy: [{ arrivalOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { requests: requests.map(toRequestView) };
  }

  @Post('requests')
  @ApiOperation({ summary: 'Create a request on behalf of a customer' })
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodBody(dispatcherCreateRequestSchema)) dto: DispatcherCreateRequestDto,
  ): Promise<{ request: RequestView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.create',
        payload: dto,
      },
      async (context) => {
        const email = dto.clientEmail.trim().toLowerCase();
        const account = await context.tx.account.upsert({
          where: { email },
          update: {},
          create: {
            email,
            createdAt: BigInt(context.now),
            updatedAt: BigInt(context.now),
          },
        });
        // The account exists so the request has an owner and a real address to write to.
        // It is not marked as a verified address: only the customer's own login proves
        // that (context/41 section 10).
        await context.tx.accountRole.upsert({
          where: { accountId_role: { accountId: account.id, role: 'client' } },
          update: {},
          create: { accountId: account.id, role: 'client', grantedAt: BigInt(context.now) },
        });

        const prepared = await this.requests.prepare(context, account.id, {
          contactName: dto.contactName,
          addressText: dto.addressText,
          lat: dto.lat ?? null,
          lon: dto.lon ?? null,
          workType: dto.workType,
          windowStartAt: dto.windowStartAt,
          windowEndAt: dto.windowEndAt,
          urgent: dto.urgent,
          problemText: dto.problemText ?? null,
        });
        // A request the dispatcher creates is already a task: there is no separate screen
        // for the customer to confirm content they did not type.
        return toRequestView(await this.requests.submit(context, prepared.id, prepared.version));
      },
    );
    return { request: outcome.result };
  }

  @Patch('requests/:id')
  @ApiOperation({ summary: 'Change the conditions of a request that has not started' })
  async update(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(dispatcherUpdateRequestSchema)) dto: DispatcherUpdateRequestDto,
  ): Promise<{ request: RequestView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.update',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toRequestView(
          await this.requests.updateConditions(context, id, dto.expectedVersion ?? null, {
            ...(dto.windowStartAt === undefined ? {} : { windowStartAt: dto.windowStartAt }),
            ...(dto.windowEndAt === undefined ? {} : { windowEndAt: dto.windowEndAt }),
            ...(dto.addressText === undefined ? {} : { addressText: dto.addressText }),
            ...(dto.lat === undefined ? {} : { lat: dto.lat }),
            ...(dto.lon === undefined ? {} : { lon: dto.lon }),
            ...(dto.urgent === undefined ? {} : { urgent: dto.urgent }),
          }),
        ),
    );
    return { request: outcome.result };
  }

  @Post('requests/:id/cancel')
  @ApiOperation({ summary: 'Cancel a request that has not started' })
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(cancelRequestSchema)) dto: CancelRequestDto,
  ): Promise<{ request: RequestView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.cancel',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toRequestView(
          await this.requests.cancel(context, id, dto.expectedVersion ?? null, dto.reason ?? null),
        ),
    );
    return { request: outcome.result };
  }

  @Get('requests/:id/history')
  @ApiOperation({ summary: 'Previous conditions of a request' })
  async history(@Param('id') id: string) {
    const request = await this.prisma.request.findUnique({ where: { id } });
    if (!request) {
      throw SysError.notFound('Request', { requestId: id });
    }
    const entries = await this.prisma.requestConditionHistory.findMany({
      where: { requestId: id },
      orderBy: { changedAt: 'desc' },
    });
    return {
      // History is a journal of what the conditions used to be. It is never a second
      // active promise to the customer (context/36 section 4).
      history: entries.map((entry) => ({
        changedAt: Number(entry.changedAt),
        operationId: entry.operationId,
        reason: entry.reason,
        previous: entry.previous,
      })),
      asOf: this.clock.nowSeconds(),
    };
  }

  @Get('engineers')
  @ApiOperation({ summary: 'Engineers with their skills, transport and current day' })
  async listEngineers(): Promise<{
    engineers: Array<EngineerView & { day: EngineerDayView | null }>;
  }> {
    const engineers = await this.prisma.engineer.findMany({
      where: { archivedAt: null },
      orderBy: { inputOrder: 'asc' },
      include: { days: { orderBy: { workDate: 'desc' }, take: 1 } },
    });
    return {
      engineers: engineers.map((engineer) => ({
        ...toEngineerView(engineer),
        // Availability, the current day and the profile stay visibly separate; they are
        // never blended into one "working / offline / unassigned" status
        // (context/39 DB4).
        day: engineer.days[0] ? toDayView(engineer.days[0]) : null,
      })),
    };
  }

  @Post('engineers')
  @ApiOperation({ summary: 'Add an engineer by email address' })
  async createEngineer(
    @CurrentActor() actor: Actor,
    @Body(zodBody(createEngineerSchema)) dto: CreateEngineerDto,
  ): Promise<{ engineer: EngineerView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.create',
        payload: dto,
      },
      async (context) =>
        toEngineerView(
          await this.engineers.create(context, {
            email: dto.email,
            displayName: dto.displayName,
            skills: dto.skills,
            transportType: dto.transportType,
            region: dto.region ?? null,
            homeLat: dto.homeLat ?? null,
            homeLon: dto.homeLon ?? null,
          }),
        ),
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
      // The same handler the engineer's own edit goes through, so the two meet the same
      // version check and neither overwrites the other silently (context/39 DB4).
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
  ): Promise<{ day: EngineerDayView }> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.set_availability',
        targetRef: id,
        payload: dto,
      },
      // Working availability only. It does not finish the work in hand and does not
      // reassign it (context/42 DF-06).
      async (context) =>
        toDayView(
          await this.engineers.setAvailability(
            context,
            id,
            dto.availability,
            dto.expectedOnlineAt ?? null,
          ),
        ),
    );
    return { day: outcome.result };
  }
}
