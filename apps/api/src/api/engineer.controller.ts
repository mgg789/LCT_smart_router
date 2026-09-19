import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, AuthService, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { EngineersService, type EngineerWithAccount } from '../orchestrator/engineers';
import { FactsService } from '../orchestrator/facts';
import { LiveService } from '../orchestrator/live';
import { PrismaService } from '../persistence';
import { AppliedPlanService } from '../routing/router-gateway';
import { type AttendanceDto, attendanceSchema } from './dto/alert.dto';
import {
  type ConfirmEmailChangeDto,
  confirmEmailChangeSchema,
  type EngineerActionDto,
  engineerActionSchema,
  type RequestEmailChangeDto,
  requestEmailChangeSchema,
  type SetAvailabilityDto,
  setAvailabilitySchema,
  type UpdateOwnProfileDto,
  updateOwnProfileSchema,
} from './dto/engineer.dto';
import { type LiveActionDto, liveActionSchema } from './dto/live.dto';
import { type ReportFactDto, reportFactSchema } from './dto/plan.dto';
import {
  type EngineerDayView,
  type EngineerView,
  toDayView,
  toEngineerView,
} from './engineer-view';
import { type EngineerLiveView } from './live-view.types';
import { type PlanRouteView, toPlanView } from './plan-view';
import { toRequestView } from './request-view';

/**
 * Engineer App contour.
 *
 * A session acts on its own engineer and no one else: the subject comes from the
 * credential, never from the payload (context/42 DF-06). An integration key has no
 * account to act as: it names the engineer object explicitly with `engineerId`, and the
 * key's category -- not the object -- decides what it may do (context/41 section 3.2).
 */
@Roles('engineer')
@ApiTags('engineer')
@Controller('engineer')
export class EngineerController {
  constructor(
    private readonly engineers: EngineersService,
    private readonly facts: FactsService,
    private readonly plans: AppliedPlanService,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly live: LiveService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'LIVE state for the signed-in engineer' })
  async liveView(
    @CurrentActor() actor: Actor,
    @Query('engineerId') engineerId?: string,
  ): Promise<EngineerLiveView> {
    const engineer = await this.subjectOf(actor, engineerId);
    return this.live.engineerView(engineer.id);
  }

  @Post('live/actions')
  @ApiOperation({ summary: 'Record one LIVE engineer action using the business clock' })
  async liveAction(
    @CurrentActor() actor: Actor,
    @Body(zodBody(liveActionSchema)) dto: LiveActionDto,
  ): Promise<EngineerLiveView> {
    const engineer = await this.subjectOf(actor, dto.engineerId);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: `live.engineer.${dto.kind}`,
        targetRef: engineer.id,
        payload: dto,
      },
      async (context) => this.live.act(context, engineer.id, dto),
    );
    return outcome.result;
  }

  @Get('profile')
  @ApiOperation({ summary: 'Profile of the signed-in engineer, or of the engineerId a key names' })
  async profile(
    @CurrentActor() actor: Actor,
    @Query('engineerId') engineerId?: string,
  ): Promise<{ engineer: EngineerView }> {
    const engineer = await this.subjectOf(actor, engineerId);
    return { engineer: toEngineerView(engineer) };
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Change own skills, transport or usual start point' })
  async updateProfile(
    @CurrentActor() actor: Actor,
    @Body(zodBody(updateOwnProfileSchema)) dto: UpdateOwnProfileDto,
  ): Promise<{ engineer: EngineerView }> {
    const engineer = await this.subjectOf(actor, dto.engineerId);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.update_profile',
        targetRef: engineer.id,
        expectedVersion: dto.expectedVersion ?? null,
        payload: dto,
      },
      async (context) =>
        toEngineerView(
          await this.engineers.updateProfile(context, engineer.id, dto.expectedVersion ?? null, {
            ...(dto.displayName === undefined ? {} : { displayName: dto.displayName }),
            ...(dto.skills === undefined ? {} : { skills: dto.skills }),
            ...(dto.transportType === undefined ? {} : { transportType: dto.transportType }),
            ...(dto.homeLat === undefined ? {} : { homeLat: dto.homeLat }),
            ...(dto.homeLon === undefined ? {} : { homeLon: dto.homeLon }),
          }),
        ),
    );
    return { engineer: outcome.result };
  }

  @Post('email-change')
  @ApiOperation({ summary: 'Send a confirmation code to a new login address' })
  async requestEmailChange(
    @CurrentActor() actor: Actor,
    @Body(zodBody(requestEmailChangeSchema)) dto: RequestEmailChangeDto,
  ) {
    const issued = await this.auth.requestOwnedEmailChange(this.sessionAccountOf(actor), dto.email);
    return {
      email: issued.email,
      expiresAt: issued.expiresAt,
      ...(issued.devCode === undefined ? {} : { devCode: issued.devCode }),
    };
  }

  @Post('email-change/confirm')
  @ApiOperation({ summary: 'Confirm a new login address with the emailed code' })
  async confirmEmailChange(
    @CurrentActor() actor: Actor,
    @Body(zodBody(confirmEmailChangeSchema)) dto: ConfirmEmailChangeDto,
  ): Promise<{ engineer: EngineerView }> {
    await this.auth.confirmOwnedEmailChange(this.sessionAccountOf(actor), dto.email, dto.code);
    const engineer = await this.engineers.byAccount(this.prisma, this.sessionAccountOf(actor));
    return { engineer: toEngineerView(engineer) };
  }

  @Get('day')
  @ApiOperation({ summary: 'Shift, availability and lunch state of the current working day' })
  async day(
    @CurrentActor() actor: Actor,
    @Query('engineerId') engineerId?: string,
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.subjectOf(actor, engineerId);
    const outcome = await this.operations.execute(
      {
        // Reading the day may create it, which is why it goes through an operation; the
        // id is derived from the engineer and the action so a refresh is not a new write.
        operationId: deterministicOperationId('engineer.day', engineer.id),
        actor,
        action: 'engineer.open_day',
        targetRef: engineer.id,
        payload: { engineerId: engineer.id },
      },
      async (context) => toDayView(await this.engineers.currentDay(context, engineer.id)),
    );
    return { day: outcome.result };
  }

  @Post('attendance')
  @ApiOperation({ summary: 'Record an explicit engineer app check-in for silence monitoring' })
  async attendance(
    @CurrentActor() actor: Actor,
    @Body(zodBody(attendanceSchema)) dto: AttendanceDto,
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.subjectOf(actor, undefined);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.attendance',
        targetRef: engineer.id,
        payload: dto,
      },
      async (context) => toDayView(await this.engineers.recordAttendance(context, engineer.id)),
    );
    return { day: outcome.result };
  }

  @Post('availability')
  @ApiOperation({ summary: 'Go online or offline' })
  async setAvailability(
    @CurrentActor() actor: Actor,
    @Body(zodBody(setAvailabilitySchema)) dto: SetAvailabilityDto,
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.subjectOf(actor, dto.engineerId);
    await this.live.assertLegacyMutationAllowed();
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.set_availability',
        targetRef: engineer.id,
        payload: dto,
      },
      async (context) =>
        toDayView(
          await this.engineers.setAvailability(
            context,
            engineer.id,
            dto.availability,
            dto.expectedOnlineAt ?? null,
          ),
        ),
    );
    return { day: outcome.result };
  }

  @Post('technical-break')
  @ApiOperation({ summary: 'Start a technical stop with an expected return' })
  async technicalBreak(
    @CurrentActor() actor: Actor,
    @Body(zodBody(engineerActionSchema)) dto: EngineerActionDto,
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.subjectOf(actor, dto.engineerId);
    await this.live.assertLegacyMutationAllowed();
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.technical_break',
        targetRef: engineer.id,
        payload: dto,
      },
      async (context) => toDayView(await this.engineers.startTechnicalBreak(context, engineer.id)),
    );
    return { day: outcome.result };
  }

  @Post('lunch/start')
  @ApiOperation({ summary: 'Record the actual start of lunch' })
  async startLunch(
    @CurrentActor() actor: Actor,
    @Body(zodBody(engineerActionSchema)) dto: EngineerActionDto,
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.subjectOf(actor, dto.engineerId);
    await this.live.assertLegacyMutationAllowed();
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.start_lunch',
        targetRef: engineer.id,
        payload: dto,
      },
      async (context) => toDayView(await this.engineers.startLunch(context, engineer.id)),
    );
    return { day: outcome.result };
  }

  @Post('lunch/finish')
  @ApiOperation({ summary: 'Record the return to work after lunch' })
  async finishLunch(
    @CurrentActor() actor: Actor,
    @Body(zodBody(engineerActionSchema)) dto: EngineerActionDto,
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.subjectOf(actor, dto.engineerId);
    await this.live.assertLegacyMutationAllowed();
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.finish_lunch',
        targetRef: engineer.id,
        payload: dto,
      },
      async (context) => toDayView(await this.engineers.finishLunch(context, engineer.id)),
    );
    return { day: outcome.result };
  }

  /**
   * The account of a session, for actions that manage the login itself.
   *
   * Changing the login address has no object-selection form: an integration key carries
   * no account, so there is nothing for it to change (context/41 section 3.2).
   */
  private sessionAccountOf(actor: Actor): string {
    if (!actor.accountId) {
      throw SysError.forbidden('The login address belongs to a session; a key has no account');
    }
    return actor.accountId;
  }

  /**
   * Which engineer this call acts on.
   *
   * A session acts on its own engineer: the subject comes from the credential, so an
   * explicit id is refused even when it names the caller's own profile -- one rule, no
   * exceptions to poke holes in (context/42 DF-06). An integration key has no account:
   * it must name the engineer, and the named object must exist (context/41 section 3.2).
   */
  private async subjectOf(
    actor: Actor,
    explicitEngineerId: string | null | undefined,
  ): Promise<EngineerWithAccount> {
    if (actor.accountId) {
      if (
        explicitEngineerId !== undefined &&
        explicitEngineerId !== null &&
        explicitEngineerId !== ''
      ) {
        throw SysError.forbidden('A session acts on its own engineer; do not pass engineerId');
      }
      return this.engineers.byAccount(this.prisma, actor.accountId);
    }
    if (
      explicitEngineerId === undefined ||
      explicitEngineerId === null ||
      explicitEngineerId === ''
    ) {
      throw SysError.validationFailed(
        'An integration key must name the engineer: pass engineerId',
        { engineerId: 'required' },
      );
    }
    return this.engineers.byId(this.prisma, explicitEngineerId);
  }

  /**
   * Request cards for the stops on this engineer's working route, in route order.
   *
   * The list endpoint would otherwise have to guess which dispatch requests belong to
   * the signed-in crew. Only ids that appear on the applied plan are loaded.
   */
  private async requestsOnRoute(route: PlanRouteView | null) {
    const ids = [
      ...new Set(
        (route?.stops ?? [])
          .map((stop) => stop.requestId)
          .filter((requestId): requestId is string => requestId !== null),
      ),
    ];
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.request.findMany({ where: { id: { in: ids } } });
    const byId = new Map(rows.map((row) => [row.id, toRequestView(row)]));
    return ids.flatMap((id) => {
      const view = byId.get(id);
      return view === undefined ? [] : [view];
    });
  }

  @Get('plan')
  @ApiOperation({
    summary: 'The working plan for the signed-in engineer, or the engineerId a key names',
  })
  async plan(@CurrentActor() actor: Actor, @Query('engineerId') engineerId?: string) {
    const engineer = await this.subjectOf(actor, engineerId);
    const plan = await this.plans.current(this.prisma);
    if (!plan) {
      // A truthful empty state, not an error: no plan has been applied yet.
      return {
        plan: null,
        route: null,
        planAsOf: null,
        origin: null,
        revision: null,
        requests: [],
      };
    }
    const view = toPlanView(plan);
    const route = view.routes.find((item) => item.engineerId === engineer.id) ?? null;
    return {
      // The engineer works from the plan sys applied, never from a background result of
      // Router directly -- which is why manual mode shows the manual plan here
      // (context/32 section 5.1).
      planAsOf: view.planAsOf,
      origin: view.origin,
      revision: view.revision,
      route,
      requests: await this.requestsOnRoute(route),
    };
  }

  @Get('requests/:id')
  @ApiOperation({ summary: 'One assigned request from the working plan' })
  async request(
    @CurrentActor() actor: Actor,
    @Param('id') requestId: string,
    @Query('engineerId') engineerId?: string,
  ) {
    const engineer = await this.subjectOf(actor, engineerId);
    if (
      await this.prisma.liveWorkday.findFirst({
        where: { status: 'running' },
        select: { id: true },
      })
    ) {
      const live = await this.live.engineerView(engineer.id);
      if (live.current?.request.id === requestId && live.current.stop) {
        return { request: live.current.request, stop: live.current.stop };
      }
    }
    const plan = await this.plans.current(this.prisma);
    if (!plan) {
      throw SysError.notFound('Request');
    }
    const view = toPlanView(plan);
    const route = view.routes.find((item) => item.engineerId === engineer.id) ?? null;
    const stop = route?.stops.find((item) => item.requestId === requestId) ?? null;
    if (stop === null) {
      throw SysError.notFound('Request');
    }
    const row = await this.prisma.request.findUnique({ where: { id: requestId } });
    if (row === null) {
      throw SysError.notFound('Request');
    }
    return { request: toRequestView(row), stop };
  }

  @Post('requests/:id/facts')
  @ApiOperation({ summary: 'Record a confirmed execution fact' })
  async reportFact(
    @CurrentActor() actor: Actor,
    @Param('id') requestId: string,
    @Body(zodBody(reportFactSchema)) dto: ReportFactDto,
  ) {
    const engineer = await this.subjectOf(actor, dto.engineerId);
    await this.live.assertLegacyMutationAllowed();
    // Router owns the thresholds. Read them before the operation opens its database
    // transaction; a private-network call must never hold a business transaction open.
    const timing = await this.facts.timing();
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: `request.fact.${dto.kind}`,
        targetRef: requestId,
        payload: dto,
      },
      async (context) =>
        toRequestView(
          await this.facts.record(
            context,
            engineer.id,
            requestId,
            dto.kind,
            dto.occurredAt ?? context.now,
            dto.note ?? null,
            timing,
          ),
        ),
    );
    return { request: outcome.result };
  }
}

/**
 * A stable id for an operation that has no caller-supplied one.
 *
 * Opening the day is a read that may create the day's row. Deriving the id from the
 * subject keeps repeated refreshes from piling up identical operations in the journal.
 */
function deterministicOperationId(action: string, subject: string): string {
  const hex = Buffer.from(`${action}:${subject}`).toString('hex').padEnd(32, '0').slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
