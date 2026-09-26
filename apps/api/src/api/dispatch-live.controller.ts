import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../auth';
import { zodBody } from '../common/validation';
import { OperationsService } from '../operations';
import { LiveService } from '../orchestrator/live';
import { type StartLiveWorkdayDto, startLiveWorkdaySchema } from './dto/live.dto';
import type { DispatchLiveView } from './live-view.types';

/** Dispatcher LIVE workday endpoints; state transitions remain in LiveService. */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchLiveController {
  constructor(
    private readonly live: LiveService,
    private readonly operations: OperationsService,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Durable LIVE workday state for the dispatcher dashboard' })
  async liveView(): Promise<DispatchLiveView> {
    return this.live.dispatchView();
  }

  @Post('live/start')
  @ApiOperation({ summary: 'Start the current LIVE workday and publish its t=0 task' })
  async startLive(
    @CurrentActor() actor: Actor,
    @Body(zodBody(startLiveWorkdaySchema)) dto: StartLiveWorkdayDto,
  ): Promise<DispatchLiveView> {
    const outcome = await this.operations.execute(
      { operationId: dto.operationId, actor, action: 'live.workday.start', payload: dto },
      async (context) => this.live.start(context),
    );
    return outcome.result;
  }
}
