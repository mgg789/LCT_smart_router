import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { SysError } from '../common/errors';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import {
  type RewardPenaltyDto,
  RewardsService,
  rewardPenaltySchema,
} from '../orchestrator/rewards';
import { PrismaService } from '../persistence';

function requiredWorkdayId(value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw SysError.validationFailed('workdayId is required', { workdayId: 'required' });
  }
  return value;
}

/** Engineer reward reads and dispatcher-controlled penalty writes. */
@ApiTags('rewards')
@Controller()
export class RewardsController {
  constructor(
    private readonly rewards: RewardsService,
    private readonly prisma: PrismaService,
    private readonly operations: OperationsService,
  ) {}

  @Get('engineer/rewards')
  @Roles('engineer')
  @ApiOperation({ summary: 'Current Moscow-month engineer reward summary' })
  async engineerSummary(@CurrentActor() actor: Actor, @Query('engineerId') engineerId?: string) {
    const id = await this.engineerSubject(actor, engineerId);
    return this.rewards.summary(id);
  }

  @Get('engineer/rewards/day')
  @Roles('engineer')
  @ApiOperation({ summary: 'Engineer reward entries for one LIVE workday' })
  async engineerDay(
    @CurrentActor() actor: Actor,
    @Query('workdayId') workdayId?: string,
    @Query('engineerId') engineerId?: string,
  ) {
    const id = await this.engineerSubject(actor, engineerId);
    return this.rewards.daySummary(id, requiredWorkdayId(workdayId));
  }

  @Get('dispatch/engineers/:id/rewards')
  @Roles('dispatcher')
  @ApiOperation({ summary: 'Dispatcher view of an engineer reward summary' })
  async dispatchSummary(@Param('id') engineerId: string) {
    return this.rewards.summary(engineerId);
  }

  @Get('dispatch/engineers/:id/rewards/day')
  @Roles('dispatcher')
  @ApiOperation({ summary: 'Dispatcher view of one engineer workday rewards' })
  async dispatchDay(@Param('id') engineerId: string, @Query('workdayId') workdayId?: string) {
    return this.rewards.daySummary(engineerId, requiredWorkdayId(workdayId));
  }

  @Get('dispatch/engineers/:id/reward-facts')
  @Roles('dispatcher')
  @ApiOperation({ summary: 'Explicit facts available for an audited manual penalty' })
  async rewardFacts(@Param('id') engineerId: string) {
    const facts = await this.prisma.requestFact.findMany({
      where: { engineerId },
      orderBy: { recordedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        requestId: true,
        kind: true,
        occurredAt: true,
        recordedAt: true,
        note: true,
        request: { select: { addressText: true } },
      },
    });
    const penalized = await this.prisma.engineerReward.findMany({
      where: { engineerId, category: 'penalty' },
      select: { evidence: true },
    });
    const penalizedFacts = new Set(
      penalized.flatMap((entry) => {
        const evidence = entry.evidence;
        return typeof evidence === 'object' &&
          evidence !== null &&
          'factId' in evidence &&
          typeof evidence.factId === 'string'
          ? [evidence.factId]
          : [];
      }),
    );
    return {
      facts: facts
        .filter((fact) => !penalizedFacts.has(fact.id))
        .map((fact) => ({
          ...fact,
          occurredAt: Number(fact.occurredAt),
          recordedAt: Number(fact.recordedAt),
        })),
    };
  }

  @Post('dispatch/engineers/:id/rewards/penalty')
  @Roles('dispatcher')
  @ApiOperation({ summary: 'Record an explicit audited minus-50 engineer penalty' })
  async penalty(
    @CurrentActor() actor: Actor,
    @Param('id') engineerId: string,
    @Body(zodBody(rewardPenaltySchema)) dto: RewardPenaltyDto,
  ) {
    const payload = { ...dto, engineerId };
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'engineer.reward.penalty',
        targetRef: dto.requestId,
        payload,
      },
      async (context) => this.rewards.recordPenalty(context, payload),
    );
    return outcome.result;
  }

  private async engineerSubject(actor: Actor, requested?: string): Promise<string> {
    if (actor.accountId) {
      if (requested) {
        throw SysError.forbidden('A session acts on its own engineer; do not pass engineerId');
      }
      const engineer = await this.prisma.engineer.findUnique({
        where: { accountId: actor.accountId },
        select: { id: true },
      });
      if (!engineer) throw SysError.notFound('Engineer');
      return engineer.id;
    }
    if (!requested) {
      throw SysError.validationFailed('An integration key must name the engineer', {
        engineerId: 'required',
      });
    }
    {
      const engineer = await this.prisma.engineer.findUnique({
        where: { id: requested },
        select: { id: true },
      });
      if (!engineer) throw SysError.notFound('Engineer', { engineerId: requested });
      return engineer.id;
    }
  }
}
