import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { AiService, MiniAiService } from '../orchestrator/ai';
import { collectOptimizeLevers, type OptimizeLever } from '../orchestrator/ai/optimize-levers';
import { LiveService } from '../orchestrator/live';
import { businessNow } from '../orchestrator/live/business-clock';
import { type UpdateMcpSettingsDto, updateMcpSettingsSchema } from '../orchestrator/mcp/mcp.dto';
import { McpService } from '../orchestrator/mcp/mcp.service';
import { type McpSettingsView } from '../orchestrator/mcp/mcp-settings';
import { PolicyService } from '../orchestrator/policy';
import {
  DispatcherSettingsService,
  GeocodingService,
  MapRoutingService,
} from '../orchestrator/settings';
import {
  readSimulation,
  rememberSimulation,
  russianDelta,
  simulationPatchHash,
  toDeltaView,
  toRouterPatch,
  toRouteView,
} from '../orchestrator/simulator';
import { PrismaService, UnitOfWork } from '../persistence';
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
import { visibleRouterPhase } from '../routing/router-gateway/router-phase';
import { type AiSettingsDto, aiSettingsSchema } from './dto/ai.dto';
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
import { type SituationPredictDto, situationPredictSchema } from './dto/prediction.dto';
import {
  type UpdateRouterTechnicalSettingsDto,
  updateRouterTechnicalSettingsSchema,
} from './dto/router.dto';
import {
  type UpdateDispatcherSettingsDto,
  updateDispatcherSettingsSchema,
} from './dto/settings.dto';
import { type SimulationPatchDto, simulationPatchSchema } from './dto/simulation.dto';
import { toPlanView } from './plan-view';
import { weatherView } from './weather-view';

/**
 * Routing and dispatcher-owned settings contour.
 *
 * Requests, engineers, LIVE, alerts and data imports have dedicated controllers. This
 * controller intentionally retains routing methods so policy, undo and strict settings
 * changes have one stable integration point for the dispatcher contour.
 */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchController {
  constructor(
    private readonly policyService: PolicyService,
    private readonly publisher: SnapshotPublisher,
    private readonly builder: SnapshotBuilder,
    private readonly plans: AppliedPlanService,
    private readonly control: ControlStateService,
    private readonly manual: ManualPlanService,
    private readonly acceptance: ResultAcceptanceService,
    private readonly router: RouterClient,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly mapRouting: MapRoutingService,
    private readonly live: LiveService,
    private readonly ai: AiService,
    private readonly miniAi: MiniAiService,
    private readonly dispatcherSettings: DispatcherSettingsService,
    private readonly geocoding: GeocodingService,
    private readonly mcp: McpService,
  ) {}

  @Get('router/technical-settings')
  @ApiOperation({ summary: 'Read Router-owned routing and execution controls' })
  async routerTechnicalSettings() {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    return this.router.getTechnicalSettings();
  }

  @Put('router/technical-settings')
  @ApiOperation({ summary: 'Replace Router-owned routing and execution controls' })
  async updateRouterTechnicalSettings(
    @CurrentActor() actor: Actor,
    @Body(zodBody(updateRouterTechnicalSettingsSchema)) dto: UpdateRouterTechnicalSettingsDto,
  ) {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    const requested = {
      operationId: dto.operationId,
      expectedContextVersion: dto.expectedContextVersion,
      lunchesEnabled: dto.lunchesEnabled,
      strictTimeWindows: dto.strictTimeWindows,
      departureLatenessToleranceSec: dto.departureLatenessToleranceSec,
      taskStartLatenessToleranceSec: dto.taskStartLatenessToleranceSec,
      windowLatenessToleranceSec: dto.windowLatenessToleranceSec,
      trafficEnabled: dto.trafficEnabled,
      metroEnabled: dto.metroEnabled,
      equipmentTransfersEnabled: dto.equipmentTransfersEnabled,
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
      () => this.router.updateTechnicalSettings(requested),
    );
    await this.live.synchronizeGlobalLunchSwitch(dto.lunchesEnabled);
    return outcome.result;
  }

  @Post('predictions/situation')
  @ApiOperation({
    summary: 'Dry Monte-Carlo probabilities for one fixed plan and execution situation',
  })
  async situationPredict(@Body(zodBody(situationPredictSchema)) dto: SituationPredictDto) {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    return this.router.predictSituation({
      input_hash: dto.inputHash,
      router_context_version: dto.routerContextVersion,
      routes: dto.routes,
      simulations: dto.simulations,
      as_of: dto.asOf ?? null,
      completed: dto.completed,
      cancel_rate: dto.cancelRate ?? null,
    });
  }

  @Get('weather')
  @ApiOperation({ summary: 'Cached Moscow forecast and the car-traffic multiplier it applies' })
  async weather() {
    if (!this.router.isConfigured()) return weatherView(null);
    try {
      return weatherView(await this.router.getWeather());
    } catch {
      return weatherView(null);
    }
  }

  @Get('policies')
  @ApiOperation({ summary: 'Prepared policies and the one in force' })
  async policies() {
    return {
      policies: this.policyService.list(),
      active: await this.policyService.active(this.prisma),
    };
  }

  @Get('policy-comparison')
  @ApiOperation({ summary: 'Compare all prepared policies and FIFO on the current task' })
  async policyComparison() {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
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
    const rosterEngineerIds = readRosterEngineerIds(current.snapshot.payload);
    await this.uow.run(async (tx) =>
      this.policyService.recordComparison(
        tx,
        comparison,
        rosterEngineerIds,
        await businessNow(this.prisma, this.clock.nowSeconds()),
      ),
    );
    return comparison;
  }

  @Post('simulate')
  @ApiOperation({ summary: 'What-if on the current publication; does not change the working plan' })
  async simulate(@Body(zodBody(simulationPatchSchema)) dto: SimulationPatchDto) {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    const patch = toRouterPatch(dto);
    const current = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      include: { snapshot: true },
    });
    if (!current)
      throw new SysError('VERSION_CONFLICT', 'There is no published planning task to simulate');
    const contextVersion = await this.router.getActiveContextVersion();
    if (!contextVersion)
      throw new SysError('VERSION_CONFLICT', 'Router has no context version for this publication');
    const hash = simulationPatchHash(patch);
    const stored = await readSimulation(
      this.prisma,
      current.snapshot.inputHash,
      contextVersion,
      hash,
    );
    const result = stored ?? (await this.router.simulate(patch));
    if (!stored) {
      if (
        result.input_hash !== current.snapshot.inputHash ||
        result.router_context_version !== contextVersion
      )
        throw new SysError(
          'VERSION_CONFLICT',
          'Planning data changed while the simulation was calculated; retry the read',
        );
      await rememberSimulation(this.prisma, patch, result);
    }
    const roster = await this.prisma.engineer.findMany({
      select: { id: true, transportType: true },
    });
    const transports = new Map(roster.map((engineer) => [engineer.id, engineer.transportType]));
    return {
      method: result.method,
      cached: result.cached,
      patchHash: result.patch_hash,
      inputHash: result.input_hash,
      routerContextVersion: result.router_context_version,
      text: russianDelta(patch, result),
      delta: toDeltaView(result),
      routes: this.mapRouting.projectSimulationRoutes(
        (result.routes ?? []).map(toRouteView),
        transports,
      ),
      strategies: (result.strategies ?? []).map((row) => ({
        strategyId: row.strategy_id,
        metrics: {
          assignedCount: row.metrics.assigned_count,
          unassignedCount: row.metrics.unassigned_count,
          lateAssignedCount: row.metrics.late_assigned_count,
          distanceKm: row.metrics.distance_km,
        },
        routes: this.mapRouting.projectSimulationRoutes(row.routes.map(toRouteView), transports),
      })),
    };
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
      const pending = await this.builder.build(this.prisma, this.clock.nowSeconds());
      return { published: false, snapshot: null, diagnostics: pending.diagnostics };
    }
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
      payload: current.snapshot.payload,
    };
  }

  @Get('plan')
  @ApiOperation({ summary: 'The applied working plan and the control mode' })
  async plan() {
    const plan = await this.plans.current(this.prisma);
    const control = await this.control.current(this.prisma);
    const lastPackage = await this.acceptance.lastPackage();
    const published = await this.prisma.routingCurrent.findUnique({
      where: { id: 'singleton' },
      select: { snapshot: { select: { inputHash: true } } },
    });
    const phase = visibleRouterPhase(
      published !== null &&
        published.snapshot.inputHash !==
          (plan?.validatedInputHash ?? plan?.routerResult?.inputHash ?? null),
    );
    return {
      mode: control.mode,
      modeVersion: control.modeVersion,
      calculating: phase.phase === 'building',
      routerPhase: phase.phase,
      routerMessage: phase.message,
      geometryDone: phase.geometryDone,
      geometryTotal: phase.geometryTotal,
      plan: plan ? this.mapRouting.projectPlan(toPlanView(plan)) : null,
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
            rejectionCode: lastPackage.rejectionCode,
            receivedAt: Number(lastPackage.receivedAt),
          }
        : null,
    };
  }

  @Post('mode')
  @ApiOperation({ summary: 'Switch emergency manual control on or off' })
  async setMode(@CurrentActor() actor: Actor, @Body(zodBody(setModeSchema)) dto: SetModeDto) {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: `control.${dto.mode}`, payload: dto },
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
      (context) => this.manual.reassign(context, dto.requestId, dto.engineerId),
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
      (context) => this.manual.reorder(context, dto.engineerId, dto.requestIds),
    );
    return outcome.result;
  }

  @Post('debug/router-result')
  @ApiOperation({ summary: 'Feed a Router result through the acceptance checks (debug contour)' })
  async submitResult(@Body(zodBody(submitResultSchema)) dto: SubmitResultDto) {
    return this.acceptance.accept(dto.result, dto.activeContextVersion ?? null);
  }

  @Post('ai/optimize')
  @ApiOperation({
    summary: 'System one picks one simulated lever; the server applies that existing operation',
  })
  async optimizeWithModel(@CurrentActor() actor: Actor, @Body() body: { summary?: unknown }) {
    const summary = typeof body.summary === 'string' ? body.summary : '';
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    const active = await this.uow.run((tx) => this.policyService.active(tx));
    const levers = await collectOptimizeLevers({
      router: this.router,
      prisma: this.prisma,
      currentPolicyId: active.policyId,
    });
    const decision = await this.miniAi.planOptimization({ summary, levers });
    const lever = levers.find((item) => item.id === decision.id);
    if (!lever)
      return { id: 'current', label: 'План уже оптимален', steps: ['План уже оптимален'] };
    await this.applyOptimizeLever(actor, lever);
    return { id: lever.id, label: lever.label, steps: decision.steps };
  }

  private async applyOptimizeLever(actor: Actor, lever: OptimizeLever): Promise<void> {
    if (lever.kind === 'policy' && lever.policyId) {
      const operationId = randomUUID();
      await this.operations.execute(
        {
          operationId,
          actor,
          action: 'policy.select',
          targetRef: lever.policyId,
          payload: { operationId, policyId: lever.policyId },
        },
        async (context) => {
          const selected = await this.policyService.select(context, lever.policyId as string);
          await this.publisher.publishIfChanged(
            context.tx,
            context.now,
            PUBLICATION_TRIGGERS.POLICY_CHANGED,
          );
          return selected;
        },
      );
      return;
    }
    if (lever.kind === 'settings' && lever.settings) {
      const current = await this.router.getTechnicalSettings();
      const operationId = randomUUID();
      const requested = {
        operationId,
        expectedContextVersion: current.routerContextVersion,
        lunchesEnabled: lever.settings.lunchesEnabled ?? current.lunchesEnabled,
        departureLatenessToleranceSec: current.departureLatenessToleranceSec,
        taskStartLatenessToleranceSec: current.taskStartLatenessToleranceSec,
        windowLatenessToleranceSec: current.windowLatenessToleranceSec,
        trafficEnabled: lever.settings.trafficEnabled ?? current.trafficEnabled,
        metroEnabled: lever.settings.metroEnabled ?? current.metroEnabled,
        equipmentTransfersEnabled: current.equipmentTransfersEnabled,
        equipmentEnabled: lever.settings.equipmentEnabled ?? current.equipmentEnabled,
        travelTimeMode: current.travelTimeMode,
        accessBufferSec: current.accessBufferSec,
        fixedTravelTimeSec: current.fixedTravelTimeSec,
        earlyFinishReplanThresholdSec: current.earlyFinishReplanThresholdSec,
        taskOverrunToleranceSec: current.taskOverrunToleranceSec,
      };
      await this.operations.executeExternal(
        {
          operationId,
          actor,
          action: 'router.technical-settings.replace',
          targetRef: 'router-core',
          expectedVersion: null,
          payload: requested,
        },
        () => this.router.updateTechnicalSettings(requested),
      );
      if (lever.settings.lunchesEnabled !== undefined)
        await this.live.synchronizeGlobalLunchSwitch(lever.settings.lunchesEnabled);
      return;
    }
    if (lever.kind === 'engineer' && lever.engineerId) {
      const operationId = randomUUID();
      await this.operations.execute(
        {
          operationId,
          actor,
          action: 'engineer.set_availability',
          targetRef: lever.engineerId,
          payload: { operationId, availability: 'online' },
        },
        (context) =>
          this.live.setDispatcherAvailability(context, lever.engineerId as string, 'online', null),
      );
    }
  }

  @Get('mcp')
  @ApiOperation({ summary: 'Dashboard MCP server state: switch, pin presence, live activity' })
  async mcpView(): Promise<McpSettingsView> {
    return this.mcp.view();
  }

  @Put('mcp')
  @ApiOperation({ summary: 'Switch the MCP server and set or rotate its pin' })
  async updateMcp(
    @CurrentActor() actor: Actor,
    @Body(zodBody(updateMcpSettingsSchema)) dto: UpdateMcpSettingsDto,
  ): Promise<McpSettingsView> {
    return this.mcp.replace(actor, dto);
  }

  @Get('ai')
  @ApiOperation({ summary: 'AI contour controls and the plan-calibration reading' })
  async aiView() {
    return this.ai.view();
  }

  @Put('ai')
  @ApiOperation({ summary: 'Replace AI contour controls (plan calibration, future endpoints)' })
  async updateAi(
    @CurrentActor() actor: Actor,
    @Body(zodBody(aiSettingsSchema)) dto: AiSettingsDto,
  ) {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'dispatch.ai.replace', payload: dto },
      async (context) => this.ai.present(await this.ai.replace(context.tx, context.now, dto)),
    );
    this.ai.scheduleRefresh();
    return outcome.result;
  }

  @Get('settings')
  @ApiOperation({ summary: 'Dispatcher-owned day clock, alert timers and map keys' })
  async dispatcherSettingsView() {
    return this.dispatcherSettings.view();
  }

  @Put('settings')
  @ApiOperation({ summary: 'Replace dispatcher-owned operational settings' })
  async updateDispatcherSettings(
    @CurrentActor() actor: Actor,
    @Body(zodBody(updateDispatcherSettingsSchema)) dto: UpdateDispatcherSettingsDto,
  ) {
    const { operationId, ...patch } = dto;
    const outcome = await this.operations.execute(
      { operationId, actor, action: 'dispatch.settings.replace', payload: dto },
      (context) => this.dispatcherSettings.replace(context, patch),
    );
    return outcome.result;
  }

  @Get('settings/maps/status')
  @ApiOperation({ summary: 'Probe configured map providers with a short Moscow sample route' })
  async mapStatus() {
    return this.mapRouting.probe();
  }

  @Get('geocode')
  @ApiOperation({ summary: 'LocationIQ autocomplete for a dispatcher address' })
  async geocode(
    @Query('q') q?: string,
    @Query('city') city?: string,
    @Query('street') street?: string,
  ) {
    return { hits: await this.geocoding.search({ q, city, street }) };
  }
}

function readRosterEngineerIds(payload: string): string[] {
  try {
    const parsed = JSON.parse(payload) as { engineers?: Array<{ engineer_id?: unknown }> };
    return (parsed.engineers ?? [])
      .flatMap((engineer) =>
        typeof engineer.engineer_id === 'string' ? [engineer.engineer_id] : [],
      )
      .sort();
  } catch {
    return [];
  }
}
