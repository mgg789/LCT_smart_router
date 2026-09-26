import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { Clock } from '../common/time';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { PrismaService } from '../persistence';
import { PlanRestoreService, RouterClient } from '../routing/router-gateway';
import { type RestorePlanDto, restorePlanSchema } from './dto/plan-restore.dto';
import { toPlanView } from './plan-view';

/** Durable before/after history and a CAS-protected restore action for dispatcher plans. */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchPlanHistoryController {
  constructor(
    private readonly restore: PlanRestoreService,
    private readonly operations: OperationsService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly router: RouterClient,
  ) {}

  @Get('plan/previous')
  @ApiOperation({ summary: 'Current plan, immediate predecessor and precise restore eligibility' })
  async previous() {
    const activeContextVersion = await this.activeContextVersion();
    const pair = await this.restore.previous(
      { tx: this.prisma, now: this.clock.nowSeconds() },
      activeContextVersion,
    );
    return {
      current: pair.current ? toPlanView(pair.current) : null,
      previous: pair.previous ? toPlanView(pair.previous) : null,
      eligibility: pair.eligibility,
    };
  }

  @Post('plan/restore')
  @ApiOperation({ summary: 'Restore the immediate predecessor as a new immutable revision' })
  async restorePlan(
    @CurrentActor() actor: Actor,
    @Body(zodBody(restorePlanSchema)) dto: RestorePlanDto,
  ) {
    // Router is read before OperationsService opens its transaction. The persisted result
    // version and the context-mutating operation journal are compared again inside that
    // transaction, alongside the revision CAS.
    const contextFence = await this.restore.contextMutationFence(this.prisma);
    const activeContextVersion = await this.activeContextVersion();
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'plan.restore',
        targetRef: String(dto.expectedRevision),
        payload: dto,
      },
      (context) =>
        this.restore.restore(context, dto.expectedRevision, activeContextVersion, contextFence),
    );
    return outcome.result;
  }

  private async activeContextVersion(): Promise<string | null> {
    return this.router.getActiveContextVersion();
  }
}
