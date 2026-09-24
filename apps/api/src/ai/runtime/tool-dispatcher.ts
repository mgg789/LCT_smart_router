import { Injectable } from '@nestjs/common';
import type { Actor } from '../../auth';
import type { AiRoleProfile } from '../../generated/prisma/client';
import type { LlmToolCall } from '../provider';

/** What a tool needs to know about the run it is executing inside of. */
export interface ToolDispatchContext {
  readonly runId: string;
  readonly conversationId: string;
  readonly actor: Actor;
  readonly roleProfile: AiRoleProfile;
}

export interface ToolDispatchResult {
  readonly ok: boolean;
  /** Safe public summary for the `tool_result` run event; never raw provider or database
   *  rows (ai-event.types.ts). */
  readonly summary: string;
  /** Fed back to the model as the `tool` message's content on the next turn. */
  readonly resultContent: string;
}

/**
 * Where the runtime executes a tool the model called.
 *
 * The tool catalogue and the prepare/confirm spine that turns a call into a business
 * operation are a later piece of work; this port is what lets `AgentRuntimeService` be
 * complete and testable before that lands. Authorisation, budget and the journal already
 * live in the runtime rather than in any `LlmProvider` (see that port's own doc comment),
 * and this is the seam where a real dispatcher plugs in without moving any of that.
 */
export abstract class ToolDispatcher {
  abstract dispatch(call: LlmToolCall, context: ToolDispatchContext): Promise<ToolDispatchResult>;
}

/** Default binding: refuses every call honestly instead of pretending to act, so a run
 *  that reaches a tool call before the real dispatcher exists still ends with a truthful
 *  transcript rather than hanging or crashing. */
@Injectable()
export class NoopToolDispatcher extends ToolDispatcher {
  async dispatch(call: LlmToolCall): Promise<ToolDispatchResult> {
    await Promise.resolve();
    return {
      ok: false,
      summary: `"${call.name}" is not available yet in this build`,
      resultContent: JSON.stringify({ error: 'tool_not_implemented' }),
    };
  }
}
