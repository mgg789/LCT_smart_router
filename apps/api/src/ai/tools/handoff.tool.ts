import { z } from 'zod';
import { effectiveRole } from '../../auth';
import { SysError } from '../../common/errors';
import { type Tx, UnitOfWork } from '../../persistence';
import { ChatEventBus } from '../runtime/chat-event.bus';
import { type AiRunEventInput, RunEventBus } from '../runtime/run-event.bus';
import { RunRegistry } from '../runtime/run-registry';
import { StopService } from '../runtime/stop.service';
import type { ToolContext, ToolResult, ToolSpec } from './tool.types';

const callDispatchHelperSchema = z.object({});
export type CallDispatchHelperArgs = z.infer<typeof callDispatchHelperSchema>;

export interface HandoffToolDeps {
  readonly uow: UnitOfWork;
  readonly stop: StopService;
  readonly bus: RunEventBus;
  readonly registry: RunRegistry;
  readonly chatBus: ChatEventBus;
}

/**
 * `call_dispatch_helper`: creates (or reuses) the one open `AiHandoff` for this
 * conversation, flips it to `dispatcher` mode, and ends the run without another
 * generation -- the waiting message the customer or engineer sees next is system text,
 * never a model turn produced after asking for help.
 *
 * Ending the run happens through the *existing* stop mechanism rather than a special case
 * in `AgentRuntimeService`: `StopService.requestStop(runId, 'handover')` is exactly the
 * signal `AiStopReason`'s own doc comment describes ("a human took the dialogue over
 * mid-generation"), and the loop's `checkpoint()` call at the top of its next iteration
 * unwinds it the same way a user-requested stop does. No runtime change is needed for
 * this tool to behave the way the product wants.
 */
export function buildCallDispatchHelperTool(
  deps: HandoffToolDeps,
): ToolSpec<CallDispatchHelperArgs> {
  return {
    name: 'call_dispatch_helper',
    description:
      'Escalate this conversation to a human dispatcher. Use it when the assistant cannot ' +
      'resolve the request itself, or the person explicitly asks for a human. This ends ' +
      "the assistant's turn; a dispatcher will reply in this same conversation.",
    schema: callDispatchHelperSchema,
    async run(ctx: ToolContext): Promise<ToolResult> {
      const role = effectiveRole(ctx.actor);
      if (!role) {
        throw SysError.forbidden('This actor has no role to request a dispatcher handoff as');
      }

      const { handoff, conversation, created } = await deps.uow.run(async (tx) => {
        const existing = await tx.aiHandoff.findFirst({
          where: { conversationId: ctx.conversationId, state: { not: 'closed' } },
        });
        if (existing) {
          const current = await tx.aiConversation.findUniqueOrThrow({
            where: { id: ctx.conversationId },
          });
          return { handoff: existing, conversation: current, created: false };
        }
        // Everything already said is the context the dispatcher is being handed, so the
        // episode starts at the current end of the dialogue and shows what came before it.
        const last = await tx.aiMessage.aggregate({
          where: { conversationId: ctx.conversationId },
          _max: { seq: true },
        });
        const identified = await identify(tx, role, ctx.accountId, ctx.engineerId ?? null);
        const opened = await tx.aiHandoff.create({
          data: {
            conversationId: ctx.conversationId,
            requestedByAccountId: ctx.accountId,
            actorRole: role,
            initiatedBy: 'user',
            requestIds: identified.requestIds,
            engineerIds: ctx.engineerId ? [ctx.engineerId] : [],
            state: 'waiting',
            startSeq: last._max.seq ?? 0,
            createdAt: BigInt(ctx.now),
          },
        });
        await nameConversation(tx, ctx.conversationId, identified.title, ctx.now);
        await moveToDispatcherMode(tx, ctx.conversationId, ctx.now);
        const current = await tx.aiConversation.findUniqueOrThrow({
          where: { id: ctx.conversationId },
        });
        return { handoff: opened, conversation: current, created: true };
      });
      const handoffId = handoff.id;

      if (created) {
        await emitLive(deps, ctx.runId, { type: 'help_requested', handoffId });
        await emitLive(deps, ctx.runId, { type: 'mode_changed', mode: 'dispatcher' });
        // Published only once the transaction above has committed, which is what puts the
        // new chat on the dispatcher's screen without them refreshing the page.
        deps.chatBus.publishState({ conversation, handoff });
      }

      // Ends this run without another generation (see the doc comment above); the model
      // never gets a further turn after calling this tool.
      await deps.stop.requestStop(ctx.runId, 'handover');

      return {
        ok: true,
        summary: created
          ? 'A dispatcher was asked to take over'
          : 'A dispatcher is already helping',
        resultContent: JSON.stringify({ handoffId, created }),
      };
    },
  };
}

/** `call_dispatch_helper` always runs inside an active tool dispatch, so `runId`'s live
 *  handle should exist; `emitForRun` is a defensive fallback, the same one
 *  `AiOperationService` uses for events raised strictly outside a live run. */
async function emitLive(
  deps: HandoffToolDeps,
  runId: string,
  event: AiRunEventInput,
): Promise<void> {
  const handle = deps.registry.get(runId);
  if (handle) {
    await deps.bus.emit(handle, event);
    return;
  }
  await deps.bus.emitForRun(runId, event);
}

/**
 * Who the dispatcher is about to talk to, in the same shape a chat they opened
 * themselves carries (`dispatch-chats.service.ts#resolveTarget`).
 *
 * Without this an escalated dialogue reached the board with no title at all and the
 * row read «Без имени», although the name was on record the whole time: the engineer's
 * own row, or the contact the customer filled in on their newest request. The handoff
 * also carries that request, so the dispatcher opens the chat with the case in hand.
 */
async function identify(
  tx: Tx,
  role: 'client' | 'engineer' | 'dispatcher',
  accountId: string,
  engineerId: string | null,
): Promise<{ title: string | null; requestIds: string[] }> {
  if (role === 'engineer') {
    const engineer = engineerId
      ? await tx.engineer.findUnique({ where: { id: engineerId } })
      : await tx.engineer.findFirst({ where: { accountId } });
    return {
      title: engineer ? `Инженер · ${engineer.displayName}` : null,
      requestIds: [],
    };
  }
  if (role === 'client') {
    const request = await tx.request.findFirst({
      where: { clientAccountId: accountId },
      orderBy: { createdAt: 'desc' },
    });
    if (!request) return { title: null, requestIds: [] };
    return {
      title: `Клиент · ${request.contactName?.trim() || request.addressText}`,
      requestIds: [request.id],
    };
  }
  return { title: null, requestIds: [] };
}

/** Names an unnamed dialogue; a title the dispatcher already saw is never overwritten. */
async function nameConversation(
  tx: Tx,
  conversationId: string,
  title: string | null,
  now: number,
): Promise<void> {
  if (!title) return;
  await tx.aiConversation.updateMany({
    where: { id: conversationId, title: null },
    data: { title, updatedAt: BigInt(now) },
  });
}

/** Only when the conversation is still in `ai` mode: a second call (a retried tool call,
 *  or a stale handoff already answered and reopened by policy elsewhere) must not bump
 *  the row's version or re-emit `mode_changed` for a transition that already happened. */
async function moveToDispatcherMode(tx: Tx, conversationId: string, now: number): Promise<void> {
  await tx.aiConversation.updateMany({
    where: { id: conversationId, mode: 'ai' },
    data: { mode: 'dispatcher', updatedAt: BigInt(now), version: { increment: 1 } },
  });
}
