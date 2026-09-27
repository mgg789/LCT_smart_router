import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { MiniAiService } from '../orchestrator/ai';
import { AlertsService } from '../orchestrator/alerts';
import {
  type CloseShiftDto,
  closeShiftSchema,
  type ResolveAlertDto,
  resolveAlertSchema,
} from './dto/alert.dto';

/** Explainable alert queue, AI wording and dispatcher resolution endpoints. */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchAlertsController {
  constructor(
    private readonly alertsService: AlertsService,
    private readonly miniAi: MiniAiService,
    private readonly clock: Clock,
    private readonly operations: OperationsService,
  ) {}

  @Get('request-priority')
  @ApiOperation({ summary: 'Current workday request priority and replacement revision' })
  async requestPriority(@Query('workDate') workDate: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate ?? ''))
      throw SysError.validationFailed('workDate is required');
    return { priority: await this.alertsService.priority(workDate) };
  }

  @Get('alerts')
  @ApiOperation({ summary: 'Explainable problems reported by the plan' })
  async alerts(@Query('workDate') workDate?: string) {
    if (workDate && !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      throw new SysError('VALIDATION_FAILED', 'workDate must be YYYY-MM-DD');
    }
    return { alerts: await this.alertsService.list(workDate) };
  }

  @Post('alerts/:id/seen')
  @ApiOperation({ summary: 'Mark an alert as seen' })
  async markAlertSeen(@Param('id') id: string) {
    await this.alertsService.markSeen(id, this.clock.nowSeconds());
    return { seen: true };
  }

  @Post('notices/:id/seen')
  @ApiOperation({ summary: 'Mark an informational notice as seen without resolving any alert' })
  async markNoticeSeen(@Param('id') id: string) {
    await this.alertsService.markSeen(id, this.clock.nowSeconds());
    return { seen: true };
  }

  @Post('ai/explain')
  @ApiOperation({ summary: 'Short language-model wording for a context the screen already has' })
  async explainWithModel(@Body() body: { kind?: unknown; context?: unknown }) {
    if (body.kind !== 'reasons' && body.kind !== 'plan') {
      throw SysError.validationFailed('kind must be reasons or plan');
    }
    return { text: await this.miniAi.explain(body.kind, body.context ?? {}) };
  }

  @Post('alerts/:id/ai-resolve')
  @ApiOperation({
    summary: 'System one picks an allowed alert action; apply=0 returns the choice only',
  })
  async resolveAlertWithModel(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Query('apply') apply?: string,
  ) {
    return this.alertsService.resolveWithSystemOne(actor, id, { apply: apply !== '0' });
  }

  @Post('alerts/:id/resolve')
  @ApiOperation({ summary: 'Apply one dispatcher-selected alert resolution atomically' })
  async resolveAlert(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Body(zodBody(resolveAlertSchema)) dto: ResolveAlertDto,
  ) {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'alert.resolve', targetRef: id, payload: dto },
      (context) => this.alertsService.resolve(context, id, dto),
    );
    return { alert: outcome.result };
  }

  @Get('alerts/:id/window-proposal')
  @ApiOperation({ summary: 'Preview a feasible same-day customer window without applying it' })
  async proposeAlertWindow(@Param('id') id: string) {
    return this.alertsService.proposeWindow(id);
  }

  @Get('shift')
  @ApiOperation({ summary: 'Day close status; open alerts are a hard close gate' })
  async shift(@Query('workDate') workDate?: string) {
    if (!workDate || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      throw new SysError('VALIDATION_FAILED', 'workDate must be YYYY-MM-DD');
    }
    return this.alertsService.shiftStatus(workDate);
  }

  @Post('shift/close')
  @ApiOperation({ summary: 'Close a day only when every blocking alert has an outcome' })
  async closeShift(
    @CurrentActor() actor: Actor,
    @Body(zodBody(closeShiftSchema)) dto: CloseShiftDto,
  ) {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'shift.close',
        targetRef: dto.workDate,
        payload: dto,
      },
      (context) => this.alertsService.closeShift(context, dto.workDate),
    );
    return outcome.result;
  }
}
