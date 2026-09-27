import { Injectable, Logger } from '@nestjs/common';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import { EngineersService } from '../../orchestrator/engineers/engineers.service';
import { PrismaService } from '../../persistence';
import type { LlmToolCall } from '../provider';
import { RunStoppedSignal } from '../runtime/stop.service';
import {
  type ToolDispatchContext,
  ToolDispatcher,
  type ToolDispatchResult,
} from '../runtime/tool-dispatcher';
import { MANUAL_TOOL_NAMES, requireManualMode } from './manual.tools';
import { segmentsFor } from './role-profile';
import { ToolRegistry } from './tool.registry';
import type { ToolContext } from './tool.types';

/**
 * The real `ToolDispatcher`: looks a call up in this profile's catalogue, validates its
 * arguments, resolves the subject from the trusted session, and runs it.
 *
 * A missing or unpermitted tool name and a schema failure are both returned as an
 * ordinary `ToolDispatchResult` with `ok: false`, never thrown -- the model gets one
 * correcting turn on the next message, and the refusal is journalled through the
 * ordinary `tool_result` run event, exactly like a business refusal from inside a tool
 * (tool.registry.ts's own doc comment on why a dispatcher profile's catalogue can be
 * empty without this dispatcher needing to know that).
 */
@Injectable()
export class AiToolDispatcher extends ToolDispatcher {
  private readonly logger = new Logger(AiToolDispatcher.name);

  constructor(
    private readonly registry: ToolRegistry,
    private readonly engineers: EngineersService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async dispatch(call: LlmToolCall, context: ToolDispatchContext): Promise<ToolDispatchResult> {
    const tool = this.registry.find(context.roleProfile, call.name);
    if (!tool) {
      return {
        ok: false,
        summary: `"${call.name}" is not available in this context`,
        resultContent: JSON.stringify({ error: 'unknown_tool', name: call.name }),
      };
    }

    const parsed = tool.schema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        ok: false,
        summary: `"${call.name}" was called with invalid arguments`,
        resultContent: JSON.stringify({
          error: 'invalid_arguments',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        }),
      };
    }

    if (!context.actor.accountId) {
      // The AI-gateway is already closed to integration keys at conversation-open time
      // (`AiController.requireAccount`'s own note); this is a defensive backstop.
      return {
        ok: false,
        summary: 'This session has no account to act as',
        resultContent: JSON.stringify({ error: 'no_account' }),
      };
    }

    const toolContext: ToolContext = {
      actor: context.actor,
      accountId: context.actor.accountId,
      engineerId: await this.resolveEngineerId(context),
      conversationId: context.conversationId,
      runId: context.runId,
      segments: segmentsFor(context.roleProfile),
      now: this.clock.nowSeconds(),
    };

    try {
      if (MANUAL_TOOL_NAMES.has(call.name)) await requireManualMode(this.prisma);
      return await tool.run(toolContext, parsed.data);
    } catch (error) {
      if (error instanceof RunStoppedSignal) throw error;
      if (error instanceof SysError) {
        return {
          ok: false,
          summary: error.message,
          resultContent: JSON.stringify({ error: error.code, message: error.message }),
        };
      }
      this.logger.error(
        `Tool "${call.name}" failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ok: false,
        summary: `"${call.name}" failed unexpectedly`,
        resultContent: JSON.stringify({ error: 'INTERNAL_ERROR' }),
      };
    }
  }

  /** The engineer profile this session resolves to, when there is one. Never taken from a
   *  tool argument (tool.types.ts's own note on `ToolContext`). */
  private async resolveEngineerId(context: ToolDispatchContext): Promise<string | null> {
    if (context.roleProfile !== 'engineer' || !context.actor.accountId) {
      return null;
    }
    try {
      const engineer = await this.engineers.byAccount(this.prisma, context.actor.accountId);
      return engineer.id;
    } catch {
      return null;
    }
  }
}
