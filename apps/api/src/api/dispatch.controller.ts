import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { AppConfigService } from '../common/config';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { EngineersService } from '../orchestrator/engineers';
import {
  DATASET_REGIONS,
  DatasetImportService,
  UploadImportService,
} from '../orchestrator/imports';
import { PolicyService } from '../orchestrator/policy';
import { RequestsService } from '../orchestrator/requests';
import { ResetService } from '../orchestrator/reset';
import { APP_STATE_KEYS, PrismaService } from '../persistence';
import {
  PUBLICATION_TRIGGERS,
  SnapshotBuilder,
  SnapshotPublisher,
} from '../routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  ManualPlanService,
  ResultAcceptanceService,
  RouterClient,
} from '../routing/router-gateway';
import {
  type ImportDatasetDto,
  importDatasetSchema,
  type ResetDto,
  resetSchema,
  type UploadDataPackageDto,
  uploadDataPackageSchema,
} from './dto/data.dto';
import {
  type CreateEngineerDto,
  createEngineerSchema,
  type LinkEngineerAccountDto,
  linkEngineerAccountSchema,
  operationOnlySchema,
  type SetAvailabilityDto,
  type SetWorkdayDto,
  setAvailabilitySchema,
  setWorkdaySchema,
  type UpdateEngineerDto,
  updateEngineerSchema,
} from './dto/engineer.dto';
import {
  type ReassignDto,
  type ReorderDto,
  reassignSchema,
  reorderSchema,
  type SetModeDto,
  type SubmitResultDto,
  setModeSchema,
  submitResultSchema,
} from './dto/plan.dto';
import { type SelectPolicyDto, selectPolicySchema } from './dto/policy.dto';
import {
  type CancelRequestDto,
  cancelRequestSchema,
  type DispatcherCreateRequestDto,
  type DispatcherUpdateRequestDto,
  dispatcherCreateRequestSchema,
  dispatcherUpdateRequestSchema,
} from './dto/request.dto';
import {
  type UpdateRouterTechnicalSettingsDto,
  updateRouterTechnicalSettingsSchema,
} from './dto/router.dto';
import {
  type EngineerDayView,
  type EngineerView,
  toDayView,
  toEngineerView,
} from './engineer-view';
import { toPlanView } from './plan-view';
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
    private readonly policyService: PolicyService,
    private readonly publisher: SnapshotPublisher,
    private readonly builder: SnapshotBuilder,
    private readonly plans: AppliedPlanService,
    private readonly control: ControlStateService,
    private readonly manual: ManualPlanService,
    private readonly acceptance: ResultAcceptanceService,
    private readonly router: RouterClient,
    private readonly imports: DatasetImportService,
    private readonly uploadImports: UploadImportService,
    private readonly resetService: ResetService,
    private readonly config: AppConfigService,
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
          ...(dto.requiredEquipment === undefined
            ? {}
            : { requiredEquipment: dto.requiredEquipment }),
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

  @Get('router/technical-settings')
  @ApiOperation({ summary: 'Read Router-owned routing and execution controls' })
  async routerTechnicalSettings() {
    if (!this.router.isConfigured()) {
      throw SysError.notConfigured('Router Core');
    }
    return this.router.getTechnicalSettings();
  }

  @Put('router/technical-settings')
  @ApiOperation({ summary: 'Replace Router-owned routing and execution controls' })
  async updateRouterTechnicalSettings(
    @CurrentActor() actor: Actor,
    @Body(zodBody(updateRouterTechnicalSettingsSchema)) dto: UpdateRouterTechnicalSettingsDto,
  ) {
    if (!this.router.isConfigured()) {
      throw SysError.notConfigured('Router Core');
    }
    const requested = {
      operationId: dto.operationId,
      expectedContextVersion: dto.expectedContextVersion,
      lunchesEnabled: dto.lunchesEnabled,
      departureLatenessToleranceSec: dto.departureLatenessToleranceSec,
      taskStartLatenessToleranceSec: dto.taskStartLatenessToleranceSec,
      windowLatenessToleranceSec: dto.windowLatenessToleranceSec,
      trafficEnabled: dto.trafficEnabled,
      equipmentEnabled: dto.equipmentEnabled,
      travelTimeMode: dto.travelTimeMode,
      accessBufferSec: dto.accessBufferSec,
      fixedTravelTimeSec: dto.fixedTravelTimeSec,
      earlyFinishReplanThresholdSec: dto.earlyFinishReplanThresholdSec,
      taskOverrunToleranceSec: dto.taskOverrunToleranceSec,
    };
    const outcome = await this.operations.executeExternal(
      {
        operationId: dto.operationId,
        actor,
        action: 'router.technical-settings.replace',
        targetRef: 'router-core',
        expectedVersion: null,
        payload: dto,
      },
      // Router owns and persists these controls. The external-operation envelope journals
      // the intent first, then releases the sys transaction before this private HTTP call.
      () => this.router.updateTechnicalSettings(requested),
    );
    return outcome.result;
  }

  @Get('policies')
  @ApiOperation({ summary: 'Prepared policies and the one in force' })
  async policies() {
    return {
      // A catalogue of prepared variants. There is no editor of weights, criteria order
      // or solver parameters here, and a rich policy structure in the contracts does not
      // create one (context/42 DF-15).
      policies: this.policyService.list(),
      active: await this.policyService.active(this.prisma),
    };
  }

  @Get('policy-comparison')
  @ApiOperation({ summary: 'Compare all prepared policies and FIFO on the current task' })
  async policyComparison() {
    if (!this.router.isConfigured()) {
      throw SysError.notConfigured('Router Core');
    }
    const comparison = await this.router.getPolicyComparison();
    const current = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    if (
      !current ||
      current.snapshot.id !== comparison.inputPublicationId ||
      current.snapshot.inputHash !== comparison.inputHash
    ) {
      throw new SysError(
        'VERSION_CONFLICT',
        'Planning data changed while the policy comparison was calculated; retry the read',
      );
    }
    return comparison;
  }

  @Post('policy')
  @ApiOperation({ summary: 'Choose a prepared policy' })
  async selectPolicy(
    @CurrentActor() actor: Actor,
    @Body(zodBody(selectPolicySchema)) dto: SelectPolicyDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'policy.select',
        targetRef: dto.policyId,
        payload: dto,
      },
      async (context) => {
        const selected = await this.policyService.select(context, dto.policyId);
        // The choice is data of the task, so it is republished. A new criterion does not
        // mean a new plan is on screen yet: until a current result is accepted, the
        // chosen policy and the policy the shown plan was built with are different things
        // (context/42 DF-15).
        const publication = await this.publisher.publishIfChanged(
          context.tx,
          context.now,
          PUBLICATION_TRIGGERS.POLICY_CHANGED,
        );
        return { ...selected, publication };
      },
    );
    return outcome.result;
  }

  @Get('debug/snapshot')
  @ApiOperation({ summary: 'The published planning task, as Router reads it' })
  async debugSnapshot() {
    const current = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    if (!current) {
      // A valid state, not an error: nothing has yet changed the planning task.
      const pending = await this.builder.build(this.prisma, this.clock.nowSeconds());
      return { published: false, snapshot: null, diagnostics: pending.diagnostics };
    }
    // Diagnostics are rebuilt from the current state rather than read off the published
    // document. The reason is specific: a request that cannot be projected -- one still
    // waiting for coordinates -- does not change the task, so nothing is republished, and
    // a count frozen at publication time would never mention it. Building them live is a
    // read; it publishes nothing and moves no pointer.
    const live = await this.builder.build(this.prisma, this.clock.nowSeconds());

    return {
      published: true,
      publicationId: current.snapshot.id,
      publicationSeq: current.pointerVersion,
      inputHash: current.snapshot.inputHash,
      planningAsOf: Number(current.snapshot.planningAsOf),
      trigger: current.snapshot.trigger,
      generation: current.snapshot.generation,
      diagnostics: live.diagnostics,
      diagnosticsAtPublication: current.snapshot.diagnostics,
      // The exact bytes Router hashes, returned as text on purpose: re-encoding them
      // would defeat the point of storing them verbatim.
      payload: current.snapshot.payload,
    };
  }

  @Get('plan')
  @ApiOperation({ summary: 'The applied working plan and the control mode' })
  async plan() {
    const plan = await this.plans.current(this.prisma);
    const control = await this.control.current(this.prisma);
    const lastPackage = await this.acceptance.lastPackage();

    return {
      mode: control.mode,
      modeVersion: control.modeVersion,
      // The moment the shown plan describes. While a recalculation is under way the
      // interface keeps this plan and says it is being rebuilt, rather than clearing the
      // day (context/36 section 6).
      plan: plan ? toPlanView(plan) : null,
      // Direct relation to the package that produced the working revision. Unlike the
      // diagnostic last package, this cannot be confused by another result received in
      // the same second.
      appliedResult: plan?.routerResult
        ? {
            resultId: plan.routerResult.resultId,
            inputHash: plan.routerResult.inputHash,
            routerContextVersion: plan.routerResult.routerContextVersion,
          }
        : null,
      lastResult: lastPackage
        ? {
            resultId: lastPackage.resultId,
            inputHash: lastPackage.inputHash,
            routerContextVersion: lastPackage.routerContextVersion,
            accepted: lastPackage.accepted,
            // Why a finished result did not become the working plan, kept so a refusal is
            // explainable rather than invisible.
            rejectionCode: lastPackage.rejectionCode,
            receivedAt: Number(lastPackage.receivedAt),
          }
        : null,
    };
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Explainable problems reported by the plan' })
  async alerts() {
    const alerts = await this.prisma.alert.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        code: alert.code,
        severity: alert.severity,
        engineerIds: alert.engineerIds,
        requestIds: alert.requestIds,
        reasons: alert.reasons,
        restoreOption: alert.restoreOption,
        createdAt: Number(alert.createdAt),
        seenAt: alert.seenAt === null ? null : Number(alert.seenAt),
        resolvedAt: alert.resolvedAt === null ? null : Number(alert.resolvedAt),
      })),
    };
  }

  @Post('alerts/:id/seen')
  @ApiOperation({ summary: 'Mark an alert as seen' })
  async markAlertSeen(@Param('id') id: string) {
    // Seen is not resolved. The underlying condition is unchanged, and it clears only when
    // the real state changes (context/39 DB2).
    await this.prisma.alert.updateMany({
      where: { id, seenAt: null },
      data: { seenAt: BigInt(this.clock.nowSeconds()) },
    });
    return { seen: true };
  }

  @Post('mode')
  @ApiOperation({ summary: 'Switch emergency manual control on or off' })
  async setMode(@CurrentActor() actor: Actor, @Body(zodBody(setModeSchema)) dto: SetModeDto) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: `control.${dto.mode}`,
        payload: dto,
      },
      async (context) =>
        dto.mode === 'manual'
          ? this.control.enterManual(context)
          : this.control.returnToAuto(context),
    );
    return { control: outcome.result };
  }

  @Post('plan/reassign')
  @ApiOperation({ summary: 'Move work that has not started to another engineer' })
  async reassign(@CurrentActor() actor: Actor, @Body(zodBody(reassignSchema)) dto: ReassignDto) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'plan.reassign',
        targetRef: dto.requestId,
        payload: dto,
      },
      async (context) => this.manual.reassign(context, dto.requestId, dto.engineerId),
    );
    return outcome.result;
  }

  @Post('plan/reorder')
  @ApiOperation({ summary: "Save the finished order of one engineer's queue" })
  async reorder(@CurrentActor() actor: Actor, @Body(zodBody(reorderSchema)) dto: ReorderDto) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'plan.reorder',
        targetRef: dto.engineerId,
        payload: dto,
      },
      async (context) => this.manual.reorder(context, dto.engineerId, dto.requestIds),
    );
    return outcome.result;
  }

  @Post('debug/router-result')
  @ApiOperation({
    summary: 'Feed a Router result through the acceptance checks (debug contour)',
  })
  async submitResult(@Body(zodBody(submitResultSchema)) dto: SubmitResultDto) {
    // The production path is the opposite direction: sys polls Router. This endpoint
    // exists only while that client does not, and it runs the identical checks -- it is a
    // way in for a test, not a second way to apply a plan (context/41 section 6.3).
    return this.acceptance.accept(dto.result, dto.activeContextVersion ?? null);
  }

  @Get('data/state')
  @ApiOperation({ summary: 'Whether the application has been initialised, and how' })
  async dataState() {
    const state = await this.prisma.appState.findMany({
      where: {
        key: {
          in: [
            APP_STATE_KEYS.INITIALIZED,
            APP_STATE_KEYS.STARTUP_PROFILE,
            APP_STATE_KEYS.GENERATION,
          ],
        },
      },
    });
    const byKey = new Map(state.map((row) => [row.key, row.value]));
    const packages = await this.prisma.importPackage.findMany({
      orderBy: { appliedAt: 'desc' },
      take: 20,
    });
    const [depots, requestRegions, engineerRegions] = await Promise.all([
      this.prisma.depot.findMany({ select: { region: true } }),
      this.prisma.request.findMany({
        where: { region: { not: null } },
        distinct: ['region'],
        select: { region: true },
      }),
      this.prisma.engineer.findMany({
        where: { region: { not: null }, archivedAt: null },
        distinct: ['region'],
        select: { region: true },
      }),
    ]);
    const availableRegions = [
      ...new Set(
        [...depots, ...requestRegions, ...engineerRegions].flatMap((item) =>
          item.region === null ? [] : [item.region],
        ),
      ),
    ].sort();
    return {
      // An empty `requests` table is not proof that setup never happened; after a
      // deliberate empty reset it is the intended state (context/37 section 9.5).
      initialized: byKey.get(APP_STATE_KEYS.INITIALIZED) ?? false,
      startupProfile: byKey.get(APP_STATE_KEYS.STARTUP_PROFILE) ?? null,
      generation: byKey.get(APP_STATE_KEYS.GENERATION) ?? 1,
      availableRegions,
      imports: packages.map((item) => ({
        source: item.source,
        checksum: item.checksum,
        appliedAt: Number(item.appliedAt),
        summary: item.summary,
      })),
    };
  }

  @Post('data/upload')
  @ApiOperation({ summary: 'Atomically load a new region or append requests from JSON' })
  async uploadData(
    @CurrentActor() actor: Actor,
    @Body(zodBody(uploadDataPackageSchema)) dto: UploadDataPackageDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.upload',
        targetRef: dto.region,
        payload: dto,
      },
      async (context) =>
        this.uploadImports.importPackage(
          context,
          dto,
          this.config.get('DATASET_TIME_ZONE_OFFSET_SEC'),
        ),
    );
    return outcome.result;
  }

  @Post('data/import')
  @ApiOperation({ summary: 'Atomically load one, several or all official dataset regions' })
  async importDataset(
    @CurrentActor() actor: Actor,
    @Body(zodBody(importDatasetSchema)) dto: ImportDatasetDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.import',
        targetRef: dto.region ?? (dto.regions === 'all' ? 'all' : dto.regions?.join(',')),
        payload: dto,
      },
      async (context) => {
        const regions = dto.region
          ? [dto.region]
          : dto.regions === 'all'
            ? [...DATASET_REGIONS]
            : (dto.regions ?? []);
        return this.imports.importRegions(
          context,
          regions,
          this.config.get('DATASET_ROOT'),
          this.config.get('DATASET_TIME_ZONE_OFFSET_SEC'),
          dto.engineerCountPerRegion ?? {},
        );
      },
    );
    return outcome.result;
  }

  @Post('data/reset')
  @ApiOperation({ summary: 'Reset to the test data, or to an empty working set' })
  async reset(@CurrentActor() actor: Actor, @Body(zodBody(resetSchema)) dto: ResetDto) {
    if (actor.kind !== 'account') {
      // A destructive reset is a confirmed human action. An integration key carries the
      // dispatcher's authority but not their confirmation (context/42 DF-24).
      throw SysError.forbidden('A reset is confirmed from the Dashboard');
    }
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: `data.reset.${dto.kind}`,
        payload: dto,
        confirmation: dto.confirmation,
      },
      async (context) => this.resetService.run(context, dto.kind, dto.confirmation),
    );
    return outcome.result;
  }
}
