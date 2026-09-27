import { z } from 'zod';
import type { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import type { PrismaService } from '../../persistence';
import { manualStateView, readManualState } from '../../routing/router-gateway/manual-state';
import type { AiOperationService } from '../operations';
import { localDateSchema, localTimeSchema, localToUnixSeconds } from './local-time';
import type { AnyToolSpec, ToolContext } from './tool.types';

export const MANUAL_TOOL_NAMES = new Set([
  'get_manual_state',
  'prepare_manual_decision',
  'prepare_manual_assignment',
  'prepare_remove_manual_decision',
  'prepare_manual_priorities',
]);

/** Refuse stale model catalogues after a dispatcher has returned to Auto. */
export async function requireManualMode(prisma: PrismaService): Promise<void> {
  const control = await prisma.controlState.findUnique({ where: { id: 'singleton' } });
  if (control?.mode !== 'manual')
    throw SysError.validationFailed(
      'manual_not_enabled: дождитесь подтверждения ручного режима диспетчером',
    );
}

/** Builtin AI requests human consent; only existing domain operations may edit intentions. */
export function buildManualTools(deps: {
  prisma: PrismaService;
  aiOperations: AiOperationService;
  config: AppConfigService;
}): readonly AnyToolSpec[] {
  const edit = z.object({
    expectedVersion: z.number().int().nonnegative(),
    kind: z.enum(['assignment', 'window', 'lunch', 'shift']),
    targetId: z.string().min(1),
    engineerId: z.string().min(1).nullable().optional(),
    date: localDateSchema.optional(),
    startLocal: localTimeSchema.optional(),
    endLocal: localTimeSchema.optional(),
  });
  const remove = z.object({
    expectedVersion: z.number().int().nonnegative(),
    decisionId: z.string().min(1),
  });
  const order = z.object({
    expectedVersion: z.number().int().nonnegative(),
    decisionIds: z.array(z.string().min(1)),
  });
  async function perform(ctx: ToolContext, action: string, payload: Record<string, unknown>) {
    await requireManualMode(deps.prisma);
    const op = await deps.aiOperations.prepare({
      actor: ctx.actor,
      accountId: ctx.accountId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      action,
      targetRef: typeof payload.targetId === 'string' ? payload.targetId : null,
      payload,
    });
    const manual = manualStateView(await readManualState(deps.prisma));
    const decision = manual.decisions.find(
      (item) => item.kind === payload.kind && item.targetId === payload.targetId,
    );
    const intentOutcome =
      op.state !== 'applied'
        ? op.state
        : decision && manual.resolution?.rejectedIds.includes(decision.id)
          ? 'rejected'
          : decision && manual.resolution?.acceptedIds.includes(decision.id)
            ? 'accepted'
            : 'pending';
    return {
      ok: op.state === 'applied' || op.state === 'awaiting_confirmation',
      summary:
        op.state === 'applied'
          ? intentOutcome === 'rejected'
            ? 'Ручное пожелание сохранено, но планировщик его отклонил. Назначение не выполнено.'
            : intentOutcome === 'accepted'
              ? 'Планировщик принял ручное пожелание. Проверьте фактического исполнителя через get_request перед сообщением о назначении.'
              : 'Ручное пожелание сохранено; назначение ещё НЕ подтверждено, ожидается пересчёт. Проверьте get_manual_state и get_request.'
          : op.state === 'awaiting_confirmation'
            ? 'Ручное решение ожидает подтверждения; пока не применено.'
            : 'Ручное решение не применено.',
      resultContent: JSON.stringify({ ...op, manual, intentOutcome, assignmentConfirmed: false }),
    };
  }
  return [
    {
      name: 'request_manual_mode',
      description:
        'LAST RESORT only: request the dispatcher confirmation dialog for atypical Manual mode. Explain why Auto and ordinary remedies are insufficient, that constraints can reduce efficiency and conflict, and that Auto clears manual decisions. This NEVER enables Manual. Wait for the user to confirm the dialog; do not claim activation or call manual edits before that.',
      schema: z.object({ reason: z.string().trim().min(1).max(2000) }),
      async run(_ctx, args: { reason: string }) {
        return {
          ok: true,
          summary: `Ожидаем подтверждения диспетчера в окне ручного режима. Причина: ${args.reason}`,
          resultContent: JSON.stringify({
            status: 'manual_not_enabled',
            reason: args.reason,
            awaitingUserConfirmation: true,
          }),
        };
      },
    },
    {
      name: 'get_manual_state',
      description:
        'Read current Manual decisions, version and conflicts before editing. Available only after dispatcher enables Manual. Lower priority numbers win; new decisions tie at highest priority.',
      schema: z.object({}),
      async run() {
        await requireManualMode(deps.prisma);
        const state = manualStateView(await readManualState(deps.prisma));
        return {
          ok: true,
          summary: 'Ручные решения и конфликты загружены.',
          resultContent: JSON.stringify(state),
        };
      },
    },
    {
      name: 'prepare_manual_assignment',
      description:
        'Assign/reassign a request to an engineer in enabled Manual. Use full IDs from get_request/list_engineers and latest expectedVersion from get_manual_state. engineerId=null unassigns. Requires no date or window. Saves an intention through the guarded operation; NOT proof of actual assignment. Poll get_manual_state then verify actual engineer in get_request before claiming success.',
      schema: z.object({
        expectedVersion: z.number().int().nonnegative(),
        requestId: z.string().min(1),
        engineerId: z.string().min(1).nullable(),
      }),
      async run(
        ctx,
        args: { expectedVersion: number; requestId: string; engineerId: string | null },
      ) {
        return perform(ctx, 'manual.decision.put', {
          expectedVersion: args.expectedVersion,
          kind: 'assignment',
          targetId: args.requestId,
          engineerId: args.engineerId,
        });
      },
    },
    {
      name: 'prepare_manual_decision',
      description:
        'Performs manual assignment/reassignment: kind=assignment, targetId=full request UUID, engineerId=chosen engineer UUID (null unassigns), expectedVersion from get_manual_state; NO date or times needed. Also saves request window, engineer lunch or shift intention in enabled Manual. Read current version first. Intervals use local date and start/end time. Existing fact and window consent checks remain mandatory; conflicts require explicit priority choice.',
      schema: edit,
      async run(ctx, args: z.infer<typeof edit>) {
        const { date, startLocal, endLocal, ...payload } = args;
        if (args.kind !== 'assignment' && (!date || !startLocal || !endLocal))
          throw SysError.validationFailed('Укажите дату и обе границы интервала');
        return perform(ctx, 'manual.decision.put', {
          ...payload,
          ...(date && startLocal && endLocal
            ? {
                startAt: localToUnixSeconds(date, startLocal, deps.config.get('APP_TIME_ZONE')),
                endAt: localToUnixSeconds(date, endLocal, deps.config.get('APP_TIME_ZONE')),
              }
            : {}),
        });
      },
    },
    {
      name: 'prepare_remove_manual_decision',
      description:
        'Remove one Manual intention using the latest session version. Does not undo actual execution.',
      schema: remove,
      run: (ctx, args) => perform(ctx, 'manual.decision.remove', remove.parse(args)),
    },
    {
      name: 'prepare_manual_priorities',
      description:
        'Resolve Manual conflicts by saving every decision ID in explicit highest-to-lowest order. Ask the dispatcher when priorities are ambiguous. Use latest version; include every decision exactly once.',
      schema: order,
      run: (ctx, args) => perform(ctx, 'manual.priorities', order.parse(args)),
    },
  ] as AnyToolSpec[];
}
