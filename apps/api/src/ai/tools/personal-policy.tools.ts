import { z } from 'zod';
import type { PolicyService } from '../../orchestrator/policy';
import {
  parsePersonalObjectiveOrder,
  personalPolicyToolSchema,
} from '../../orchestrator/policy/personal-policy';
import type { PrismaService } from '../../persistence';
import type { AiOperationService } from '../operations';
import type { AnyToolSpec } from './tool.types';

/** The consultant's sole write exception: personal preferences, never selecting a plan. */
export function buildPersonalPolicyTools(deps: {
  policy: PolicyService;
  prisma: PrismaService;
  aiOperations: AiOperationService;
}): readonly AnyToolSpec[] {
  return [
    {
      name: 'get_personal_policy',
      description:
        'Read your dispatcher account saved personal policy, version, defaults and all nine supported objectives. Display all nine objectives as numbered 1–9 in the returned field order and all six switches as numbered yes/no choices. Accept any valid digit permutation, including contiguous 123456789. Ask ONLY for missing answers, never repeat answered questions. Summarize the agreed order and preset before saving. Preserve emergency priority, coverage and all hard constraints. First array item has highest importance; no numeric weights or unsafe constraint overrides.',
      schema: z.object({}),
      async run(ctx) {
        return {
          ok: true,
          summary: 'Личная политика и доступные критерии загружены.',
          resultContent: JSON.stringify(await deps.policy.personal(deps.prisma, ctx.accountId)),
        };
      },
    },
    {
      name: 'save_personal_policy',
      description:
        'Save agreed personal objective order for this dispatcher only, in both Consultant and Agent modes. The ONLY Consultant write exception. Use numbered objectives and numbered switches from get_personal_policy; accept compact digit order or separated digits. Ask only missing answers and obtain agreement. Include all objectives exactly once and expectedVersion (0 for new). Does NOT select the policy. If this owner account profile is already selected, changes update the active plan preferences and trigger recalculation; explain this before saving. The switch preset applies ONLY on later explicit selection; saving even an active profile NEVER reapplies switches or pins later switch changes.',
      schema: personalPolicyToolSchema,
      async run(ctx, args: z.infer<typeof personalPolicyToolSchema>) {
        const result = await deps.aiOperations.prepare({
          actor: ctx.actor,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          action: 'policy.personal.save',
          targetRef: 'personal',
          payload: { ...args, objectiveOrder: parsePersonalObjectiveOrder(args.objectiveOrder) },
        });
        return {
          ok: result.state === 'applied' || result.state === 'awaiting_confirmation',
          summary:
            result.state === 'applied'
              ? 'Личная политика сохранена. Активный профиль обновлён только если уже был выбран.'
              : 'Личная политика ожидает подтверждения; ещё не сохранена.',
          resultContent: JSON.stringify(result),
        };
      },
    },
  ] as AnyToolSpec[];
}
