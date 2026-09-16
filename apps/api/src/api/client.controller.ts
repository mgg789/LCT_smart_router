import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { RequestsService, WORK_TYPES } from '../orchestrator/requests';
import { PrismaService } from '../persistence';
import {
  type PrepareRequestDto,
  prepareRequestSchema,
  type RescheduleRequestDto,
  rescheduleRequestSchema,
  type SubmitRequestDto,
  submitRequestSchema,
} from './dto/request.dto';
import { type RequestView, toRequestView } from './request-view';

/**
 * Client App contour.
 *
 * The customer describes a problem, a place and a convenient window. Qualification codes,
 * durations and transport restrictions are formed by the system and never typed here
 * (context/32 section 4.1).
 */
@Roles('client')
@ApiTags('client')
@Controller('client')
export class ClientController {
  constructor(
    private readonly requests: RequestsService,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('work-types')
  @ApiOperation({ summary: 'Types of work the customer can choose from' })
  workTypes() {
    return {
      workTypes: WORK_TYPES.map((type) => ({ code: type.code, title: type.title })),
    };
  }

  @Post('requests')
  @ApiOperation({ summary: 'Prepare a request; it is not yet submitted' })
  async prepare(
    @CurrentActor() actor: Actor,
    @Body(zodBody(prepareRequestSchema)) dto: PrepareRequestDto,
  ): Promise<{ request: RequestView }> {
    const clientAccountId = this.accountOf(actor);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.prepare',
        payload: dto,
      },
      async (context) =>
        toRequestView(
          await this.requests.prepare(context, clientAccountId, {
            contactName: dto.contactName,
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
          }),
        ),
    );
    return { request: outcome.result };
  }

  @Post('requests/:id/submit')
  @ApiOperation({ summary: 'Confirm the prepared content and send the request' })
  async submit(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(submitRequestSchema)) dto: SubmitRequestDto,
  ): Promise<{ request: RequestView }> {
    await this.assertOwned(actor, id);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.submit',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toRequestView(await this.requests.submit(context, id, dto.expectedVersion ?? null)),
    );
    return { request: outcome.result };
  }

  @Post('requests/:id/reschedule')
  @ApiOperation({ summary: 'Change the date and window of the same request, immediately' })
  async reschedule(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(rescheduleRequestSchema)) dto: RescheduleRequestDto,
  ): Promise<{ request: RequestView }> {
    await this.assertOwned(actor, id);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.reschedule',
        targetRef: id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toRequestView(
          await this.requests.reschedule(context, id, dto.expectedVersion ?? null, {
            windowStartAt: dto.windowStartAt,
            windowEndAt: dto.windowEndAt,
          }),
        ),
    );
    return { request: outcome.result };
  }

  @Get('requests')
  @ApiOperation({ summary: 'Active requests of the signed-in customer' })
  async list(@CurrentActor() actor: Actor): Promise<{ requests: RequestView[] }> {
    const clientAccountId = this.accountOf(actor);
    const requests = await this.prisma.request.findMany({
      // A completed request leaves the active list but stays in the database and in the
      // history (context/32 section 4.4).
      where: {
        clientAccountId,
        lifecycle: { in: ['draft', 'submitted', 'in_progress'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { requests: requests.map(toRequestView) };
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'One request of the signed-in customer' })
  async byId(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
  ): Promise<{ request: RequestView }> {
    const request = await this.assertOwned(actor, id);
    return { request: toRequestView(request) };
  }

  /**
   * A session acts for one account, so a client session may only reach its own requests.
   *
   * An integration key is different by design: it belongs to the dispatcher and selects an
   * object rather than identifying its owner (context/41 section 3.2), so it is not given
   * an account to act as here.
   */
  private accountOf(actor: Actor): string {
    if (!actor.accountId) {
      throw SysError.forbidden(
        'This action needs a customer session; an integration key has no account to act as',
      );
    }
    return actor.accountId;
  }

  private async assertOwned(actor: Actor, requestId: string) {
    const request = await this.prisma.request.findUnique({ where: { id: requestId } });
    if (!request) {
      throw SysError.notFound('Request', { requestId });
    }
    if (actor.accountId && request.clientAccountId !== actor.accountId) {
      // Reported as absent rather than forbidden: confirming that someone else's request
      // exists is itself a disclosure.
      throw SysError.notFound('Request', { requestId });
    }
    return request;
  }
}
