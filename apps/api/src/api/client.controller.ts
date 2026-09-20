import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { assertWriteApplied, OperationsService } from '../operations';
import { RequestsService, WORK_TYPES } from '../orchestrator/requests';
import { PrismaService, type Tx } from '../persistence';
import {
  type CancelRequestDto,
  cancelRequestSchema,
  type NotificationSettingsDto,
  notificationSettingsSchema,
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
 *
 * Who the request belongs to follows the same two-way rule as the engineer contour: a
 * session prepares and lists its own requests, an integration key names the customer by
 * address -- the object is selected by the payload, the key's category decides what may
 * be done (context/41 sections 3.2 and 10).
 */
@Roles('client')
@ApiTags('client')
@Controller('client')
export class ClientController {
  constructor(
    private readonly requests: RequestsService,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
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
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'request.prepare',
        payload: dto,
      },
      async (context) => {
        const clientAccountId = await this.clientAccountOf(context.tx, actor, dto.clientEmail);
        return toRequestView(
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
        );
      },
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

  @Post('requests/:id/cancel')
  @ApiOperation({ summary: 'Cancel own request that has not started' })
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(cancelRequestSchema)) dto: CancelRequestDto,
  ): Promise<{ request: RequestView }> {
    await this.assertOwned(actor, id);
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

  @Patch('notifications')
  @ApiOperation({ summary: 'Turn event letters to this address on or off; login codes stay on' })
  async setNotificationSettings(
    @CurrentActor() actor: Actor,
    @Body(zodBody(notificationSettingsSchema)) dto: NotificationSettingsDto,
  ): Promise<{ enabled: boolean }> {
    // Silence is a decision of a person, not of a machine: a session decides for its own
    // address, an integration key has no address of its own to silence.
    if (!actor.accountId) {
      throw SysError.forbidden('An integration key has no address to silence');
    }
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'client.notification_settings',
        targetRef: actor.accountId,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) => {
        const current = await context.tx.account.findUniqueOrThrow({
          where: { id: actor.accountId as string },
        });
        const updated = await context.tx.account.updateMany({
          where: { id: actor.accountId as string, version: dto.expectedVersion ?? current.version },
          data: {
            mailNotificationsEnabled: dto.enabled,
            updatedAt: BigInt(context.now),
            version: { increment: 1 },
          },
        });
        assertWriteApplied('Account', updated.count, dto.expectedVersion, current.version);
        return { enabled: dto.enabled };
      },
    );
    return outcome.result;
  }

  @Get('requests')
  @ApiOperation({
    summary: 'Active requests of the signed-in customer, or of the clientEmail a key names',
  })
  async list(
    @CurrentActor() actor: Actor,
    @Query('clientEmail') clientEmail?: string,
  ): Promise<{ requests: RequestView[] }> {
    const clientAccountId = await this.existingClientAccountOf(actor, clientEmail);
    if (clientAccountId === null) {
      // A never-seen address owns no requests; a read does not create the account.
      return { requests: [] };
    }
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
   * Which customer account this call acts for, creating the address's account on a write
   * the same way the dispatcher's own create does.
   *
   * A session acts for its own account: passing `clientEmail` is refused, because the
   * subject comes from the credential (context/42 DF-06). An integration key has no
   * account: it must name the customer by address (context/41 sections 3.2 and 10), and
   * the machine call never proves that the address owner confirmed anything.
   */
  private async clientAccountOf(
    tx: Tx,
    actor: Actor,
    explicitEmail: string | null | undefined,
  ): Promise<string> {
    if (actor.accountId) {
      if (explicitEmail !== undefined && explicitEmail !== null && explicitEmail !== '') {
        throw SysError.forbidden('A session acts for its own account; do not pass clientEmail');
      }
      return actor.accountId;
    }
    if (explicitEmail === undefined || explicitEmail === null || explicitEmail === '') {
      throw SysError.validationFailed(
        'An integration key must name the customer: pass clientEmail',
        { clientEmail: 'required' },
      );
    }
    const email = explicitEmail.trim().toLowerCase();
    const now = BigInt(this.clock.nowSeconds());
    const account = await tx.account.upsert({
      where: { email },
      update: {},
      create: { email, createdAt: now, updatedAt: now },
    });
    await tx.accountRole.upsert({
      where: { accountId_role: { accountId: account.id, role: 'client' } },
      update: {},
      create: { accountId: account.id, role: 'client', grantedAt: now },
    });
    return account.id;
  }

  /**
   * Same two-way resolution for reads: an unknown address owns nothing, so a missing
   * account is an empty list rather than a created row.
   */
  private async existingClientAccountOf(
    actor: Actor,
    explicitEmail: string | null | undefined,
  ): Promise<string | null> {
    if (actor.accountId) {
      if (explicitEmail !== undefined && explicitEmail !== null && explicitEmail !== '') {
        throw SysError.forbidden('A session acts for its own account; do not pass clientEmail');
      }
      return actor.accountId;
    }
    if (explicitEmail === undefined || explicitEmail === null || explicitEmail === '') {
      throw SysError.validationFailed(
        'An integration key must name the customer: pass clientEmail',
        { clientEmail: 'required' },
      );
    }
    const account = await this.prisma.account.findUnique({
      where: { email: explicitEmail.trim().toLowerCase() },
    });
    return account?.id ?? null;
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
