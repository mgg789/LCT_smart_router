import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
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
}
