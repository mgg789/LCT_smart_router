import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Delete, Get, Logger, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { assertManualConflictResolved } from '../operations/manual-conflict-guard';
import { AiService, factoryCalibrationDocument, MiniAiService } from '../orchestrator/ai';
import { collectOptimizeLevers, type OptimizeLever } from '../orchestrator/ai/optimize-levers';
import { workDateOf } from '../orchestrator/engineers/workday';
import { LiveService } from '../orchestrator/live';
import { businessNow } from '../orchestrator/live/business-clock';
import { type UpdateMcpSettingsDto, updateMcpSettingsSchema } from '../orchestrator/mcp/mcp.dto';
import { McpService } from '../orchestrator/mcp/mcp.service';
import { type McpSettingsView } from '../orchestrator/mcp/mcp-settings';
import { PolicyService } from '../orchestrator/policy';
import { personalPolicyUpdateSchema } from '../orchestrator/policy/personal-policy';
import { applyPersonalPolicyRouterPreset } from '../orchestrator/policy/personal-policy-preset';
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
import { ManualDecisionsService } from '../routing/router-gateway/manual-decisions.service';
import { manualStateView, readManualState } from '../routing/router-gateway/manual-state';
import { visibleRouterPhase } from '../routing/router-gateway/router-phase';
import { type AiSettingsDto, aiSettingsSchema } from './dto/ai.dto';
import {
  manualDeleteSchema,
  manualEditSchema,
  manualOrderSchema,
  type ReassignDto,
  type ReorderDto,
  reassignSchema,
  reorderSchema,
  type SetModeDto,
  type SubmitResultDto,
  setModeSchema,
  submitResultSchema,
} from './dto/plan.dto';
import {
  type OrdinaryReplanningDto,
  ordinaryReplanningSchema,
  type SelectPolicyDto,
  selectPolicySchema,
} from './dto/policy.dto';
import { type SituationPredictDto, situationPredictSchema } from './dto/prediction.dto';
import {
  type RouteCacheSwitchDto,
  type UpdateRouterTechnicalSettingsDto,
  routeCacheSwitchSchema,
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
  private readonly logger = new Logger(DispatchController.name);
  private readonly weatherEvidenceFlights = new Set<string>();
  constructor(
    private readonly policyService: PolicyService,
    private readonly publisher: SnapshotPublisher,
    private readonly builder: SnapshotBuilder,
    private readonly plans: AppliedPlanService,
    private readonly control: ControlStateService,
    private readonly manual: ManualPlanService,
    private readonly manualDecisions: ManualDecisionsService,
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

  @Get('router/cache')
  @ApiOperation({ summary: 'Route-response cache size, memory source and growth check' })
  routeCache() {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    return this.router.getRouteCache();
  }

  @Post('router/cache/clear')
  @ApiOperation({ summary: 'Delete cached route-engine3 responses' })
  clearRouteCache() {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    return this.router.clearRouteCache();
  }

  @Put('router/cache')
  @ApiOperation({ summary: 'Enable or disable the route-response cache' })
  setRouteCache(@Body(zodBody(routeCacheSwitchSchema)) dto: RouteCacheSwitchDto) {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    return this.router.setRouteCacheEnabled(dto.enabled);
  }

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
    const workingSetGeneration = Number(await this.ai.currentWorkingSetGeneration());
    const calibrationOverride = await this.ai.predictionCalibrationOverride(workingSetGeneration);
    const input = {
      input_hash: dto.inputHash,
      router_context_version: dto.routerContextVersion,
      routes: dto.routes,
      simulations: dto.simulations,
      as_of: dto.asOf ?? null,
      completed: dto.completed,
      cancel_rate: dto.cancelRate ?? null,
      working_set_generation: workingSetGeneration,
      ...(calibrationOverride ? { calibration_override: calibrationOverride } : {}),
    };
    const prediction = await this.router.predictSituation(input);
    const flightKey = `${dto.inputHash}:${dto.routerContextVersion}`;
    if (!this.weatherEvidenceFlights.has(flightKey)) {
      this.weatherEvidenceFlights.add(flightKey);
      void this.captureWeatherRiskEvidence(dto, input)
        .catch((error: unknown) => {
          // Shadow evidence must never make the ordinary, read-only forecast unavailable.
          this.logger.debug(`Weather shadow evidence was not captured: ${String(error)}`);
        })
        .finally(() => this.weatherEvidenceFlights.delete(flightKey));
    }
    return prediction;
  }

  /** Stores paired predictions only when the request is an exact replay of the applied route. */
  private async captureWeatherRiskEvidence(
    dto: SituationPredictDto,
    input: {
      input_hash: string;
      router_context_version: string;
      routes: Record<string, string[]>;
      simulations: number;
      as_of: number | null;
      completed: Record<string, string[]>;
      cancel_rate: number | null;
      working_set_generation: number;
    },
  ): Promise<void> {
    const shadow = await this.ai.weatherShadowOverride();
    if (!shadow) return;
    const expectedGeneration = await this.ai.currentWorkingSetGeneration();
    const plan = await this.plans.current(this.prisma);
    if (!plan || plan.routerResult?.inputHash !== dto.inputHash) return;
    const currentRoutes = Object.fromEntries(
      plan.routes.map((route) => [
        route.engineerId,
        route.stops
          .filter((stop) => stop.kind === 'job' && stop.requestId !== null)
          .map((stop) => stop.requestId as string),
      ]),
    );
    if (!sameRoutes(currentRoutes, dto.routes)) return;
    const active = await this.router.getPredictCalibration().catch(() => null);
    const baselineCalibration = {
      ...(active?.calibration ?? factoryCalibrationDocument()),
      weather_multipliers: [],
    };
    const requestIds = [...new Set(Object.values(currentRoutes).flat())];
    const [requests, engineers, settings] = await Promise.all([
      this.prisma.request.findMany({
        where: { id: { in: requestIds } },
        select: { id: true, windowEndAt: true, lifecycle: true },
      }),
      this.prisma.engineer.findMany({
        where: { id: { in: Object.keys(currentRoutes) } },
        select: { id: true, region: true, transportType: true },
      }),
      this.router.getTechnicalSettings().catch(() => null),
    ]);
    const requestById = new Map(requests.map((row) => [row.id, row]));
    const engineerById = new Map(engineers.map((row) => [row.id, row]));
    const capturedRecordedAt = Math.floor(this.clock.nowSeconds());
    const simulationAsOf = await businessNow(this.prisma, this.clock.nowSeconds());
    const finishedFacts = await this.prisma.requestFact.findMany({
      where: {
        requestId: { in: requestIds },
        engineerId: { in: Object.keys(currentRoutes) },
        kind: 'finished',
        occurredAt: { lte: BigInt(simulationAsOf) },
        recordedAt: { lte: BigInt(capturedRecordedAt) },
      },
      select: { requestId: true, engineerId: true },
    });
    const finishedByEngineer = new Map<string, Set<string>>();
    for (const fact of finishedFacts) {
      if (!fact.engineerId) continue;
      const finished = finishedByEngineer.get(fact.engineerId) ?? new Set<string>();
      finished.add(fact.requestId);
      finishedByEngineer.set(fact.engineerId, finished);
    }
    const actualCompleted = Object.fromEntries(
      Object.entries(currentRoutes).map(([engineerId, route]) => {
        const finished = finishedByEngineer.get(engineerId) ?? new Set<string>();
        const prefix: string[] = [];
        for (const requestId of route) {
          if (!finished.has(requestId)) break;
          prefix.push(requestId);
        }
        return [engineerId, prefix];
      }),
    );
    const evidenceInput = { ...input, as_of: simulationAsOf, completed: actualCompleted };
    const captureTime = Math.floor(this.clock.nowSeconds());
    const eligibleCandidates = shadow.candidates.filter((candidate) =>
      plan.routes.some((route) => {
        const engineer = engineerById.get(route.engineerId);
        return (
          engineer?.region === candidate.region &&
          engineer.transportType === candidate.transport_type
        );
      }),
    );
    if (!eligibleCandidates.length) return;
    const candidateIndex = captureTime % eligibleCandidates.length;
    const selectedCandidate = eligibleCandidates[candidateIndex];
    if (!selectedCandidate) return;
    const captureCandidates = [selectedCandidate];
    const paired = new Map<
      string,
      {
        baseline: Record<string, { breach_prob: number | null }>;
        candidate: Record<string, { breach_prob: number | null }>;
      }
    >();
    for (const candidate of captureCandidates) {
      const hasGroupRoute = plan.routes.some((route) => {
        const engineer = engineerById.get(route.engineerId);
        return (
          engineer?.region === candidate.region &&
          engineer.transportType === candidate.transport_type
        );
      });
      if (!hasGroupRoute) continue;
      const scenarioSeed = createHash('sha256')
        .update(
          JSON.stringify({
            planId: plan.id,
            inputHash: dto.inputHash,
            routerContextVersion: dto.routerContextVersion,
            candidateVersion: candidate.candidate_version,
            routes: currentRoutes,
            simulations: dto.simulations,
          }),
        )
        .digest('hex')
        .slice(0, 32);
      const [factoryPrediction, candidatePrediction] = await Promise.all([
        this.router.predictSituation({
          ...evidenceInput,
          calibration_override: baselineCalibration,
          scenario_seed: scenarioSeed,
        }),
        this.router.predictSituation({
          ...evidenceInput,
          calibration_override: {
            ...shadow.calibration,
            weather_multipliers: shadow.calibration.weather_multipliers.filter(
              (item) => item.validation_version === candidate.candidate_version,
            ),
          },
          scenario_seed: scenarioSeed,
        }),
      ]);
      paired.set(candidate.candidate_version, {
        baseline: factoryPrediction.requests,
        candidate: candidatePrediction.requests,
      });
    }
    // Use a fresh server clock after simulations and recheck lifecycle facts. A finish
    // arriving while the paired predictions run must never become a pre-finish label.
    const predictedAt = await businessNow(this.prisma, this.clock.nowSeconds());
    const recordedAt = Math.floor(this.clock.nowSeconds());
    const finalFinishedFacts = await this.prisma.requestFact.findMany({
      where: {
        requestId: { in: requestIds },
        engineerId: { in: Object.keys(currentRoutes) },
        kind: 'finished',
        occurredAt: { lte: BigInt(predictedAt) },
        recordedAt: { lte: BigInt(recordedAt) },
      },
      select: { requestId: true },
    });
    const alreadyFinished = new Set(finalFinishedFacts.map((fact) => fact.requestId));
    const evidence: Array<Parameters<AiService['recordWeatherRiskPredictions']>[1][number]> = [];
    for (const route of plan.routes) {
      const engineer = engineerById.get(route.engineerId);
      if (!engineer?.region) continue;
      const order = currentRoutes[route.engineerId] ?? [];
      for (let index = 0; index < order.length; index += 1) {
        const requestId = order[index];
        if (!requestId || (dto.completed[route.engineerId] ?? []).includes(requestId)) continue;
        const request = requestById.get(requestId);
        if (!request || request.lifecycle === 'completed' || alreadyFinished.has(requestId))
          continue;
        const stop = route.stops.find((candidate) => candidate.requestId === requestId);
        if (!stop) continue;
        const workDate = workDateOf(Number(stop.arrivalAt), 'Europe/Moscow');
        const terminalTolerance =
          !settings?.strictTimeWindows && index === order.length - 1 ? 1200 : 0;
        const allowedLateness = settings?.strictTimeWindows
          ? 0
          : Math.max(settings?.windowLatenessToleranceSec ?? 0, terminalTolerance);
        for (const candidate of captureCandidates) {
          if (
            candidate.region !== engineer.region ||
            candidate.transport_type !== engineer.transportType
          )
            continue;
          const predictions = paired.get(candidate.candidate_version);
          const baselineProbability = predictions?.baseline[requestId]?.breach_prob;
          const candidateProbability = predictions?.candidate[requestId]?.breach_prob;
          if (
            baselineProbability === null ||
            baselineProbability === undefined ||
            candidateProbability === null ||
            candidateProbability === undefined
          )
            continue;
          evidence.push({
            planId: plan.id,
            requestId,
            engineerId: engineer.id,
            region: candidate.region,
            transportType: candidate.transport_type,
            weatherKind: candidate.kind,
            workDate,
            candidateVersion: candidate.candidate_version,
            inputHash: dto.inputHash,
            routerContextVersion: dto.routerContextVersion,
            predictedAt,
            baselineProbability,
            candidateProbability,
            breachAfterAt: Number(request.windowEndAt) + allowedLateness,
          });
        }
      }
    }
    await this.ai.recordWeatherRiskPredictions(expectedGeneration, evidence);
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
  async policies(@CurrentActor() actor: Actor) {
    return {
      policies: await this.policyService.listFor(this.prisma, actor.accountId),
      active: await this.policyService.active(this.prisma),
    };
  }

  @Get('policy/personal')
  @ApiOperation({ summary: 'Own saved personal policy, defaults and supported dimensions' })
  async personalPolicy(@CurrentActor() actor: Actor) {
    return this.policyService.personal(this.prisma, actor.accountId);
  }

  @Put('policy/personal')
  @ApiOperation({
    summary: 'Save own policy without selecting it; replan only when already active',
  })
  async savePersonalPolicy(
    @CurrentActor() actor: Actor,
    @Body(zodBody(personalPolicyUpdateSchema.extend({ operationId: z.uuid() }))) dto: z.infer<
      typeof personalPolicyUpdateSchema
    > & { operationId: string },
  ) {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'policy.personal.save', payload: dto },
      async (context) => {
        const result = await this.policyService.savePersonal(context, dto);
        if (result.activeUpdated)
          await this.publisher.publishIfChanged(
            context.tx,
            context.now,
            PUBLICATION_TRIGGERS.POLICY_CHANGED,
          );
        return result;
      },
    );
    return outcome.result;
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

  @Post('policy/ordinary-replanning')
  @ApiOperation({ summary: 'Control automatic replanning for new ordinary requests' })
  async setOrdinaryReplanning(
    @CurrentActor() actor: Actor,
    @Body(zodBody(ordinaryReplanningSchema)) dto: OrdinaryReplanningDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'policy.ordinary_replanning',
        targetRef: 'singleton',
        payload: dto,
      },
      async (context) => {
        const released = await this.policyService.setOrdinaryReplanning(context, dto.disabled);
        if (released > 0)
          await this.publisher.publishIfChanged(
            context.tx,
            context.now,
            PUBLICATION_TRIGGERS.POLICY_CHANGED,
          );
        return { ordinaryReplanningDisabled: dto.disabled, released };
      },
    );
    return outcome.result;
  }

  @Post('policy')
  @ApiOperation({ summary: 'Choose a prepared policy' })
  async selectPolicy(
    @CurrentActor() actor: Actor,
    @Body(zodBody(selectPolicySchema)) dto: SelectPolicyDto,
  ) {
    // A retry must replay its operation without resetting switches edited after selection.
    if (
      dto.policyId === 'personal' &&
      !(await this.prisma.operation.findUnique({ where: { operationId: dto.operationId } }))
    ) {
      await assertManualConflictResolved(this.prisma, {
        operationId: dto.operationId,
        actor,
        action: 'policy.select',
        payload: dto,
      });
      const { profile } = await this.policyService.personal(this.prisma, actor.accountId);
      if (!profile) throw SysError.validationFailed('Личная политика не создана');
      await applyPersonalPolicyRouterPreset(this.router, this.live, profile.preset);
    }
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
          ? this.control.enterManual(context, dto.reason)
          : this.control.returnToAuto(context),
    );
    return { control: outcome.result };
  }

  /** Current durable constraints and latest solver conflict witnesses. */
  @Get('manual')
  async manualState() {
    return this.uow.run(async (tx) => manualStateView(await readManualState(tx)));
  }

  @Post('manual/decisions')
  async editManual(
    @CurrentActor() actor: Actor,
    @Body(zodBody(manualEditSchema)) dto: z.infer<typeof manualEditSchema>,
  ) {
    const { operationId, expectedVersion, ...input } = dto;
    const outcome = await this.operations.execute(
      { operationId, actor, action: 'manual.edit', payload: dto },
      (context) => this.manualDecisions.put(context, expectedVersion, input),
    );
    return outcome.result;
  }

  @Post('manual/priorities')
  async orderManual(
    @CurrentActor() actor: Actor,
    @Body(zodBody(manualOrderSchema)) dto: z.infer<typeof manualOrderSchema>,
  ) {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'manual.priorities', payload: dto },
      (context) => this.manualDecisions.reorder(context, dto.expectedVersion, dto.decisionIds),
    );
    return outcome.result;
  }

  @Delete('manual/decisions/:id')
  async deleteManual(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(manualDeleteSchema)) dto: z.infer<typeof manualDeleteSchema>,
  ) {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'manual.delete', payload: { ...dto, id } },
      (context) => this.manualDecisions.remove(context, dto.expectedVersion, id),
    );
    return outcome.result;
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
  @ApiOperation({ summary: 'Replace AI contour controls and live model connections' })
  async updateAi(
    @CurrentActor() actor: Actor,
    @Body(zodBody(aiSettingsSchema)) dto: AiSettingsDto,
  ) {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'dispatch.ai.replace', payload: dto },
      async (context) => this.ai.present(await this.ai.replace(context.tx, context.now, dto)),
    );
    await this.ai.refreshConnections();
    if (dto.planCalibrationEnabled === false) await this.ai.rollbackToFactory();
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

function sameRoutes(
  left: Readonly<Record<string, readonly string[]>>,
  right: Readonly<Record<string, readonly string[]>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => {
      const other = rightKeys[index];
      const a = left[key] ?? [];
      const b = other ? (right[other] ?? []) : [];
      return (
        key === other &&
        a.length === b.length &&
        a.every((requestId, position) => requestId === b[position])
      );
    })
  );
}
