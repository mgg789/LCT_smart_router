import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { AppConfigService } from '../common/config';
import { SysError } from '../common/errors';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { AiService } from '../orchestrator/ai';
import { DemoStandService } from '../orchestrator/demo-stand';
import {
  DATASET_REGIONS,
  DatasetImportService,
  ImportPreparationService,
  UploadImportService,
} from '../orchestrator/imports';
import { ResetService } from '../orchestrator/reset';
import { RoadImportService } from '../orchestrator/road-import';
import { APP_STATE_KEYS, PrismaService } from '../persistence';
import { RouterClient } from '../routing/router-gateway';
import {
  type ImportDatasetDto,
  type ImportPreparationActionDto,
  importDatasetSchema,
  importPreparationActionSchema,
  type ResetDto,
  type RestartDemoDto,
  resetSchema,
  restartDemoSchema,
  type UploadDataPackageDto,
  uploadDataPackageSchema,
} from './dto/data.dto';
import { type RoadImportDto, roadImportSchema } from './dto/road-import.dto';

/** Dataset, road-resource, demo rewind and reset endpoints. */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchDataController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operations: OperationsService,
    private readonly config: AppConfigService,
    private readonly imports: DatasetImportService,
    private readonly importPreparations: ImportPreparationService,
    private readonly uploadImports: UploadImportService,
    private readonly roadImports: RoadImportService,
    private readonly resetService: ResetService,
    private readonly demoStand: DemoStandService,
    private readonly router: RouterClient,
    private readonly ai: AiService,
  ) {}

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
      initialized: byKey.get(APP_STATE_KEYS.INITIALIZED) ?? false,
      startupProfile: byKey.get(APP_STATE_KEYS.STARTUP_PROFILE) ?? null,
      generation: byKey.get(APP_STATE_KEYS.GENERATION) ?? 1,
      demoStand: this.demoStand.enabled,
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
      (context) =>
        this.uploadImports.importPackage(
          context,
          dto,
          this.config.get('DATASET_TIME_ZONE_OFFSET_SEC'),
        ),
    );
    return outcome.result;
  }

  @Post('data/upload/prepare')
  @ApiOperation({ summary: 'Validate and prepare an immutable upload batch for review' })
  async prepareUploadData(
    @CurrentActor() actor: Actor,
    @Body(zodBody(uploadDataPackageSchema)) dto: UploadDataPackageDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.upload.prepare',
        targetRef: dto.region,
        payload: dto,
      },
      (context) =>
        this.importPreparations.prepareUpload(
          context,
          actor,
          dto,
          this.config.get('DATASET_TIME_ZONE_OFFSET_SEC'),
        ),
    );
    return outcome.result;
  }

  @Post('data/upload/prepare/:prepareId/confirm')
  @ApiOperation({ summary: 'Confirm and atomically apply a reviewed upload batch' })
  async confirmUploadData(
    @CurrentActor() actor: Actor,
    @Param('prepareId') prepareId: string,
    @Body(zodBody(importPreparationActionSchema)) dto: ImportPreparationActionDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.upload.confirm',
        targetRef: prepareId,
        payload: { prepareId },
      },
      (context) => this.importPreparations.confirm(context, actor, prepareId),
    );
    return outcome.result;
  }

  @Post('data/upload/prepare/:prepareId/cancel')
  @ApiOperation({ summary: 'Cancel an upload preparation without changing business data' })
  async cancelUploadData(
    @CurrentActor() actor: Actor,
    @Param('prepareId') prepareId: string,
    @Body(zodBody(importPreparationActionSchema)) dto: ImportPreparationActionDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.upload.cancel',
        targetRef: prepareId,
        payload: { prepareId },
      },
      (context) => this.importPreparations.cancel(context, actor, prepareId),
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
      (context) => {
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

  @Post('data/import/prepare')
  @ApiOperation({ summary: 'Validate and prepare official regions for dispatcher review' })
  async prepareDatasetImport(
    @CurrentActor() actor: Actor,
    @Body(zodBody(importDatasetSchema)) dto: ImportDatasetDto,
  ) {
    const regions = dto.region
      ? [dto.region]
      : dto.regions === 'all'
        ? [...DATASET_REGIONS]
        : (dto.regions ?? []);
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.import.prepare',
        targetRef: dto.region ?? (dto.regions === 'all' ? 'all' : dto.regions?.join(',')),
        payload: dto,
      },
      (context) =>
        this.importPreparations.prepareOfficial(
          context,
          actor,
          regions,
          this.config.get('DATASET_ROOT'),
          this.config.get('DATASET_TIME_ZONE_OFFSET_SEC'),
          dto.engineerCountPerRegion ?? {},
        ),
    );
    return outcome.result;
  }

  @Post('data/import/prepare/:prepareId/confirm')
  @ApiOperation({ summary: 'Confirm and atomically apply reviewed official regions' })
  async confirmDatasetImport(
    @CurrentActor() actor: Actor,
    @Param('prepareId') prepareId: string,
    @Body(zodBody(importPreparationActionSchema)) dto: ImportPreparationActionDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.import.confirm',
        targetRef: prepareId,
        payload: { prepareId },
      },
      (context) => this.importPreparations.confirm(context, actor, prepareId),
    );
    return outcome.result;
  }

  @Post('data/import/prepare/:prepareId/cancel')
  @ApiOperation({
    summary: 'Cancel an official dataset preparation without changing business data',
  })
  async cancelDatasetImport(
    @CurrentActor() actor: Actor,
    @Param('prepareId') prepareId: string,
    @Body(zodBody(importPreparationActionSchema)) dto: ImportPreparationActionDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'data.import.cancel',
        targetRef: prepareId,
        payload: { prepareId },
      },
      (context) => this.importPreparations.cancel(context, actor, prepareId),
    );
    return outcome.result;
  }

  @Post('data/road-import')
  @Post('road-import')
  @ApiOperation({ summary: 'Import a native OSRM JSON or gzip road resource' })
  async importRoadData(
    @CurrentActor() actor: Actor,
    @Body(zodBody(roadImportSchema)) dto: RoadImportDto,
  ) {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    const outcome = await this.operations.executeExternal(
      {
        operationId: dto.operationId,
        actor,
        action: 'router.road_import',
        targetRef: dto.profile,
        payload: dto,
      },
      () => this.roadImports.importRoadData(dto),
    );
    return outcome.result;
  }

  @Post('data/restart-demo')
  @ApiOperation({
    summary: 'Rewind the public 14/3 demo day (DEMO_STAND only); keeps the dispatcher session',
  })
  async restartDemo(
    @CurrentActor() actor: Actor,
    @Body(zodBody(restartDemoSchema)) dto: RestartDemoDto,
  ) {
    if (actor.kind !== 'account')
      throw SysError.forbidden('Demo rewind is confirmed from the Dashboard');
    this.demoStand.assertEnabled();
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'data.restart_demo', payload: dto },
      (context) => this.demoStand.restore(context),
    );
    if (this.router.isConfigured()) await this.ai.rollbackToFactory();
    return outcome.result;
  }

  @Post('data/reset')
  @ApiOperation({ summary: 'Reset to the test data, or to an empty working set' })
  async reset(@CurrentActor() actor: Actor, @Body(zodBody(resetSchema)) dto: ResetDto) {
    if (actor.kind !== 'account')
      throw SysError.forbidden('A reset is confirmed from the Dashboard');
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: `data.reset.${dto.kind}`,
        payload: dto,
        confirmation: dto.confirmation,
      },
      async (context) => {
        if (dto.kind === 'demo' && this.demoStand.enabled) {
          ResetService.assertConfirmation(dto.kind, dto.confirmation);
          return this.demoStand.restore(context);
        }
        return this.resetService.run(context, dto.kind, dto.confirmation);
      },
    );
    if (this.router.isConfigured()) await this.ai.rollbackToFactory();
    return outcome.result;
  }
}
