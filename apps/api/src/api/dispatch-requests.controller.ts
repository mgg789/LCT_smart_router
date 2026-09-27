import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { AuditService, OperationsService } from '../operations';
import { EngineersService } from '../orchestrator/engineers';
import { PassportsService } from '../orchestrator/passports';
import { RequestsService } from '../orchestrator/requests';
import { PrismaService } from '../persistence';
import {
  type CancelRequestDto,
  cancelRequestSchema,
  type DispatcherCreateRequestDto,
  type DispatcherUpdateRequestDto,
  dispatcherCreateRequestSchema,
  dispatcherUpdateRequestSchema,
} from './dto/request.dto';
import { type RequestView, toRequestView } from './request-view';

/** Dispatcher request reads and mutations. Each operation keeps its original UoW envelope. */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchRequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly engineers: EngineersService,
    private readonly passports: PassportsService,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  @Get('requests')
  @ApiOperation({ summary: 'Requests of the day, including started, finished and cancelled' })
  async list(
    @Query('lifecycle') lifecycle?: string,
    @Query('assignment') assignment?: string,
  ): Promise<{ requests: RequestView[] }> {
    const requests = await this.prisma.request.findMany({
      where: {
        ...(lifecycle ? { lifecycle: lifecycle as never } : {}),
        ...(assignment ? { assignmentState: assignment as never } : {}),
      },
      orderBy: [{ arrivalOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const live = await this.prisma.liveRequestState.findMany({
      where: { workday: { status: 'running' } },
      select: { requestId: true, assumedStartedAt: true, assumedCompletedAt: true },
    });
    const states = new Map(live.map((item) => [item.requestId, item]));
    return {
      requests: requests.map((request) => toRequestView(request, states.get(request.id) ?? null)),
    };
  }

  @Get('requests/:id/passport')
  @ApiOperation({ summary: 'Object passport for any dispatcher-visible request' })
  async passport(@Param('id') requestId: string) {
    return this.passports.dispatcherRead(requestId);
  }

  @Get('engineers/:id/points')
  @ApiOperation({ summary: 'Current Moscow-month passport points of an engineer' })
  async engineerPoints(@Param('id') engineerId: string) {
    await this.engineers.byId(this.prisma, engineerId);
    return this.passports.monthlyPoints(engineerId);
  }

  @Post('requests')
  @ApiOperation({ summary: 'Create and submit an unplanned request' })
  async create(
    @CurrentActor() actor: Actor,
    @Body(zodBody(dispatcherCreateRequestSchema)) dto: DispatcherCreateRequestDto,
  ): Promise<{ request: RequestView }> {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'request.create', payload: dto },
      async (context) => {
        let clientAccountId: string | null = null;
        if (dto.clientEmail) {
          const email = dto.clientEmail.trim().toLowerCase();
          const account = await context.tx.account.upsert({
            where: { email },
            update: {},
            create: { email, createdAt: BigInt(context.now), updatedAt: BigInt(context.now) },
          });
          await context.tx.accountRole.upsert({
            where: { accountId_role: { accountId: account.id, role: 'client' } },
            update: {},
            create: { accountId: account.id, role: 'client', grantedAt: BigInt(context.now) },
          });
          clientAccountId = account.id;
        }
        const prepared = await this.requests.prepare(context, clientAccountId, {
          contactName: dto.contactName ?? null,
          addressText: dto.addressText,
          lat: dto.lat ?? null,
          lon: dto.lon ?? null,
          workType: dto.workType,
          ...(dto.requiredEquipment === undefined
            ? {}
            : { requiredEquipment: dto.requiredEquipment }),
          windowStartAt: dto.windowStartAt,
          windowEndAt: dto.windowEndAt,
          urgent: dto.urgent,
          problemText: dto.problemText ?? null,
        });
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
            ...(dto.requiredEquipment === undefined
              ? {}
              : { requiredEquipment: dto.requiredEquipment }),
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
    if (!request) throw SysError.notFound('Request', { requestId: id });
    const entries = await this.prisma.requestConditionHistory.findMany({
      where: { requestId: id },
      orderBy: { changedAt: 'desc' },
    });
    const actors = await this.audit.actorsFor(
      entries.flatMap((entry) => (entry.operationId === null ? [] : [entry.operationId])),
    );
    return {
      history: entries.map((entry) => ({
        changedAt: Number(entry.changedAt),
        operationId: entry.operationId,
        reason: entry.reason,
        previous: entry.previous,
        actor: entry.operationId === null ? null : (actors.get(entry.operationId) ?? null),
      })),
      asOf: this.clock.nowSeconds(),
    };
  }
}
