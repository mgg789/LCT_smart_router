import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { EngineersService, GpsService } from '../orchestrator/engineers';
import { FactsService } from '../orchestrator/facts';
import { PrismaService } from '../persistence';
import { AppliedPlanService } from '../routing/router-gateway';
import {
  type GpsObservationDto,
  gpsObservationSchema,
  operationOnlySchema,
  type SetAvailabilityDto,
  setAvailabilitySchema,
  type UpdateOwnProfileDto,
  updateOwnProfileSchema,
} from './dto/engineer.dto';
import { type ReportFactDto, reportFactSchema } from './dto/plan.dto';
import {
  type EngineerDayView,
  type EngineerView,
  toDayView,
  toEngineerView,
} from './engineer-view';
import { toPlanView } from './plan-view';
import { toRequestView } from './request-view';

/**
 * Engineer App contour.
 *
 * Everything here acts on the signed-in engineer and no one else: the subject comes from
 * the session, never from the payload (context/42 DF-06).
 *
 * The day's plan is not served here yet -- it is the applied working plan, which arrives
 * with the ROUTER-gateway branch.
 */
@Roles('engineer')
@ApiTags('engineer')
@Controller('engineer')
export class EngineerController {
  constructor(
    private readonly engineers: EngineersService,
    private readonly gps: GpsService,
    private readonly facts: FactsService,
    private readonly plans: AppliedPlanService,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: 'Profile of the signed-in engineer' })
  async profile(@CurrentActor() actor: Actor): Promise<{ engineer: EngineerView }> {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
    return { engineer: toEngineerView(engineer) };
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Change own skills, transport or usual start point' })
  async updateProfile(
    @CurrentActor() actor: Actor,
    @Body(zodBody(updateOwnProfileSchema)) dto: UpdateOwnProfileDto,
  ): Promise<{ engineer: EngineerView }> {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
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

  @Get('day')
  @ApiOperation({ summary: 'Shift, availability and lunch state of the current working day' })
  async day(@CurrentActor() actor: Actor): Promise<{ day: EngineerDayView }> {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
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

  @Post('availability')
  @ApiOperation({ summary: 'Go online or offline' })
  async setAvailability(
    @CurrentActor() actor: Actor,
    @Body(zodBody(setAvailabilitySchema)) dto: SetAvailabilityDto,
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
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
    @Body(zodBody(operationOnlySchema)) dto: { operationId: string },
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
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
    @Body(zodBody(operationOnlySchema)) dto: { operationId: string },
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
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
    @Body(zodBody(operationOnlySchema)) dto: { operationId: string },
  ): Promise<{ day: EngineerDayView }> {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
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

  @Post('gps')
  @ApiOperation({ summary: 'Report a position; collection is voluntary' })
  async reportPosition(
    @CurrentActor() actor: Actor,
    @Body(zodBody(gpsObservationSchema)) dto: GpsObservationDto,
  ): Promise<{ recorded: true }> {
    await this.gps.record(this.accountOf(actor), dto.observedAt, dto.lat, dto.lon);
    // Storing a point changes no plan, confirms no arrival and publishes nothing
    // (context/42 DF-09).
    return { recorded: true };
  }

  private accountOf(actor: Actor): string {
    if (!actor.accountId) {
      throw SysError.forbidden(
        'This action needs an engineer session; an integration key has no account to act as',
      );
    }
    return actor.accountId;
  }

  @Get('plan')
  @ApiOperation({ summary: 'The working plan for the signed-in engineer' })
  async plan(@CurrentActor() actor: Actor) {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
    const plan = await this.plans.current(this.prisma);
    if (!plan) {
      // A truthful empty state, not an error: no plan has been applied yet.
      return { plan: null, route: null, planAsOf: null };
    }
    const view = toPlanView(plan);
    return {
      // The engineer works from the plan sys applied, never from a background result of
      // Router directly -- which is why manual mode shows the manual plan here
      // (context/32 section 5.1).
      planAsOf: view.planAsOf,
      origin: view.origin,
      revision: view.revision,
      route: view.routes.find((route) => route.engineerId === engineer.id) ?? null,
    };
  }

  @Post('requests/:id/facts')
  @ApiOperation({ summary: 'Record a confirmed execution fact' })
  async reportFact(
    @CurrentActor() actor: Actor,
    @Param('id') requestId: string,
    @Body(zodBody(reportFactSchema)) dto: ReportFactDto,
  ) {
    const engineer = await this.engineers.byAccount(this.prisma, this.accountOf(actor));
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
