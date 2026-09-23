import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../auth';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import type { AlertAction } from '../../orchestrator/alerts/alert-policy';
import { alertActionsFor } from '../../orchestrator/alerts/alert-policy';
import { PrismaService } from '../../persistence';
import type { ResolveAlertPayload } from '../operations/ai-action.catalog';
import { AiOperationService } from '../operations/ai-operation.service';
import { LlmProvider, type LlmToolSpec, runProviderTurn } from '../provider';
import { AI_FALLBACK_PROVIDER, BudgetService, ConversationService } from '../runtime';
import { localToUnixSeconds } from '../tools/local-time';
import { type AddEngineerCandidate, addEngineerCandidates } from './alert-candidates';
import { type AlertResolverProposal, buildAlertResolverSchema } from './alert-resolver.schema';

export type SuggestAlertResolutionOutcome =
  | {
      readonly refused: false;
      readonly proposal: AlertResolverProposal;
      readonly aiOperationId: string;
    }
  | { readonly refused: true; readonly why: string };

const PROPOSE_TOOL_NAME = 'propose_alert_resolution';

const ALERT_RESOLVER_SYSTEM_PROMPT = [
  'You are the alert-resolution assistant for a field-engineer dispatch system.',
  'You never invent a fact: every engineer id, time and number in your proposal must come from the context below.',
  `Call the "${PROPOSE_TOOL_NAME}" tool exactly once with your proposal; do not answer in plain text.`,
  'Choose "action" only from the allowed catalogue given in the context -- it is the complete list, not an example.',
  'Choose "engineerId" only from the candidate list given in the context, when the action needs one.',
  'List up to three other options you considered in "rejected", each with a short reason you did not choose it.',
  'Give a plain-language "reason" (in Russian) grounded only in the given context, and a "confidence" between 0 and 1.',
].join(' ');

/**
 * The alert resolver micro-agent.
 *
 * A synchronous request/response, not a streamed run: `suggest()` calls the model once
 * for a single structured proposal (a forced tool call carrying the per-alert Zod schema
 * as its JSON Schema, the same `z.toJSONSchema()` boundary `tool.registry.ts` already
 * uses) and returns the validated result directly. Validation is refusal, never coercion
 * (task brief): a proposal that fails the per-alert schema, or passes it but fails one of
 * `alerts.service.ts#applyAction`'s real preconditions, comes back as `{refused: true,
 * why}` -- there is no retry loop nudging the model toward a legal answer.
 */
@Injectable()
export class AlertResolverService {
  private readonly logger = new Logger(AlertResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
    private readonly conversations: ConversationService,
    private readonly budgets: BudgetService,
    private readonly aiOperations: AiOperationService,
    private readonly provider: LlmProvider,
    @Inject(AI_FALLBACK_PROVIDER) private readonly fallbackProvider: LlmProvider | null,
  ) {}

  async suggest(actor: Actor, alertId: string): Promise<SuggestAlertResolutionOutcome> {
    const accountId = requireAccount(actor);
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) {
      throw SysError.notFound('Alert', { alertId });
    }
    if (alert.kind !== 'alert') {
      return { refused: true, why: 'A notice has no resolution action to suggest.' };
    }
    if (alert.resolvedAt !== null || alert.invalidatedAt !== null) {
      return { refused: true, why: 'This alert is already resolved.' };
    }
    const allowed = alertActionsFor(alert.code);
    if (allowed.length === 0) {
      return {
        refused: true,
        why: `The "${alert.code}" alert offers no dispatcher action to suggest.`,
      };
    }

    const request = alert.requestIds[0]
      ? await this.prisma.request.findUnique({ where: { id: alert.requestIds[0] } })
      : null;
    const engineerDays = alert.workDate
      ? await this.prisma.engineerDay.findMany({
          where: { workDate: alert.workDate },
          include: { engineer: true },
        })
      : [];
    const candidates: AddEngineerCandidate[] = allowed.includes('add_engineer')
      ? addEngineerCandidates(
          alert.engineerIds,
          request,
          engineerDays.map((day) => ({ ...day.engineer, days: [day] })),
        )
      : [];

    const routeLegs = await this.roadSituation(alert.engineerIds);
    const contextText = buildContext({
      alertId,
      code: alert.code,
      severity: alert.severity,
      reasons: alert.reasons,
      restoreOption: alert.restoreOption,
      request,
      engineerDays,
      candidates,
      routeLegs,
      allowed,
    });

    const schema = buildAlertResolverSchema({
      allowedActions: allowed,
      candidateEngineerIds: candidates.map((item) => item.engineerId),
    });

    const conversation = await this.conversations.getOrCreate({
      accountId,
      role: 'dispatcher',
      roleProfile: 'dispatcher_fix',
      contextRef: { scope: 'alert_resolver', alertId },
    });
    const reservation = await this.budgets.reserve(accountId);
    const startedAt = this.clock.nowSeconds();
    let proposalArgs: unknown;
    let usage = { promptTokens: 0, completionTokens: 0 };
    let runState: 'completed' | 'failed' = 'completed';
    let errorCode: string | null = null;
    try {
      ({ proposalArgs, usage } = await this.callModel(contextText, schema));
    } catch (error) {
      runState = 'failed';
      errorCode = error instanceof SysError ? error.code : 'AI_UNAVAILABLE';
      this.logger.warn(
        `Alert resolver call failed for alert ${alertId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const costMicros = costMicrosFor(usage.promptTokens, usage.completionTokens, this.config);
    await this.budgets.settle(reservation, accountId, costMicros);
    const run = await this.prisma.aiRun.create({
      data: {
        conversationId: conversation.id,
        accountId,
        quotaDay: reservation.quotaDay,
        quotaAccountId: accountId,
        roleProfile: 'dispatcher_fix',
        state: runState,
        providerKind: this.provider.kind,
        model: this.config.get('LLM_MODEL'),
        reservedMicros: reservation.reservedMicros,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costMicros,
        startedAt: BigInt(startedAt),
        finishedAt: BigInt(this.clock.nowSeconds()),
        errorCode,
      },
    });

    if (runState === 'failed') {
      return { refused: true, why: `The assistant is unavailable: ${errorCode}.` };
    }
    if (proposalArgs === undefined) {
      return { refused: true, why: 'The assistant did not return a proposal for this alert.' };
    }
    const parsed = schema.safeParse(proposalArgs);
    if (!parsed.success) {
      return {
        refused: true,
        why: `The assistant's proposal did not match the allowed catalogue: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
      };
    }
    const proposal = parsed.data as AlertResolverProposal;

    const refusal = checkAlertResolutionPreconditions(
      proposal,
      alert,
      request,
      candidates,
      this.config.get('APP_TIME_ZONE'),
    );
    if (refusal) {
      return { refused: true, why: refusal };
    }

    const payload = toResolvePayload(proposal, this.config.get('APP_TIME_ZONE'));
    const prepared = await this.aiOperations.prepare({
      actor,
      accountId,
      conversationId: conversation.id,
      runId: run.id,
      action: 'alert.resolve',
      targetRef: alertId,
      payload,
    });

    return { refused: false, proposal, aiOperationId: prepared.operationId };
  }

  /** One forced tool call, single step, no retry-toward-legality: a malformed or illegal
   *  answer is refused by the caller, never resent to the model for a second try. */
  private async callModel(
    contextText: string,
    schema: z.ZodType,
  ): Promise<{ proposalArgs: unknown; usage: { promptTokens: number; completionTokens: number } }> {
    const tool: LlmToolSpec = {
      name: PROPOSE_TOOL_NAME,
      description: 'Propose exactly one validated alert resolution.',
      parametersJsonSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    };
    const retryResult = {
      current: { providerKind: this.provider.kind, usedFallback: false, attempts: 0 },
    };
    let proposalArgs: unknown;
    let textFallback = '';
    let usage = { promptTokens: 0, completionTokens: 0 };
    for await (const event of runProviderTurn(
      {
        model: this.config.get('LLM_MODEL'),
        system: ALERT_RESOLVER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contextText }],
        tools: [tool],
        maxOutputTokens: this.config.get('LLM_MAX_OUTPUT_TOKENS'),
        temperature: 0,
        signal: new AbortController().signal,
      },
      this.provider,
      this.fallbackProvider,
      this.config.get('LLM_MAX_ATTEMPTS'),
      retryResult,
    )) {
      if (event.type === 'tool_call' && event.call.name === PROPOSE_TOOL_NAME) {
        proposalArgs = event.call.arguments;
      } else if (event.type === 'text_delta') {
        textFallback += event.text;
      } else if (event.type === 'done') {
        usage = event.usage;
      }
    }
    if (proposalArgs !== undefined) {
      return { proposalArgs, usage };
    }
    // The model answered in plain text instead of calling the tool. Try to read it as
    // JSON before giving up -- still a single attempt, never a second prompt asking it
    // to try again.
    try {
      return {
        proposalArgs: textFallback.trim().length > 0 ? JSON.parse(textFallback) : undefined,
        usage,
      };
    } catch {
      return { proposalArgs: undefined, usage };
    }
  }

  private async roadSituation(engineerIds: readonly string[]): Promise<string[]> {
    if (engineerIds.length === 0) {
      return [];
    }
    const pointer = await this.prisma.appliedPlanCurrent.findUnique({
      where: { id: 'singleton' },
      include: { plan: { include: { routes: true } } },
    });
    const routes =
      pointer?.plan.routes.filter((route) => engineerIds.includes(route.engineerId)) ?? [];
    return routes.flatMap((route) => {
      const legs = Array.isArray(route.legs) ? (route.legs as Array<Record<string, unknown>>) : [];
      return legs.map(
        (leg) =>
          `engineer ${route.engineerId}: leg travelTimeSec=${leg.travelTimeSec ?? 'null'} distanceKm=${leg.distanceKm ?? 'null'} travelSource=${leg.travelSource ?? 'null'} trafficFactor=${leg.trafficFactor ?? 'null'}`,
      );
    });
  }
}

/**
 * Mirrors `alerts.service.ts#applyAction`'s real preconditions for exactly the actions
 * this deliverable enumerates, so a refusal names the same reason the dispatcher would
 * hit confirming the card by hand -- just surfaced earlier. A pure function (no DI, no
 * I/O) so the six scenarios are each a plain unit test, not an integration test standing
 * up a database and a model.
 */
export function checkAlertResolutionPreconditions(
  proposal: AlertResolverProposal,
  alert: { code: string; restoreOption: unknown },
  request: { lifecycle: string } | null,
  candidates: readonly AddEngineerCandidate[],
  timeZone: string,
): string | null {
  if (proposal.action === 'move_window' || proposal.action === 'reschedule') {
    if (request?.lifecycle !== 'submitted') {
      return 'Only a submitted request can have its window moved or rescheduled.';
    }
    if (proposal.action === 'move_window') {
      if (!proposal.windowDate || !proposal.windowStartLocal || !proposal.windowEndLocal) {
        return 'move_window needs windowDate, windowStartLocal and windowEndLocal.';
      }
      const start = localToUnixSeconds(proposal.windowDate, proposal.windowStartLocal, timeZone);
      const end = localToUnixSeconds(proposal.windowDate, proposal.windowEndLocal, timeZone);
      if (end <= start) {
        return 'move_window needs both bounds ordered: the new window end must be after its start.';
      }
    }
  }
  if (proposal.action === 'add_engineer') {
    if (
      !proposal.engineerId ||
      !candidates.some((item) => item.engineerId === proposal.engineerId)
    ) {
      return 'add_engineer needs an engineerId from the server-computed candidate list.';
    }
  }
  if (proposal.action === 'extend') {
    if (proposal.minutes === undefined) {
      return 'extend needs a positive minutes value.';
    }
    if (alert.code === 'shift_no_show' && proposal.minutes !== 15) {
      return 'A no-show can only be extended by exactly 15 minutes.';
    }
  }
  if (proposal.action === 'keep_manual' && proposal.reason.trim().length === 0) {
    return 'keep_manual needs a non-empty reason.';
  }
  if (proposal.action === 'restore_auto' && alert.restoreOption === null) {
    return 'restore_auto is impossible: this alert carries no verified restoreOption.';
  }
  return null;
}

function requireAccount(actor: Actor): string {
  if (!actor.accountId) {
    throw SysError.forbidden(
      'An integration key has no confirmed email to own an alert suggestion',
    );
  }
  return actor.accountId;
}

function toResolvePayload(proposal: AlertResolverProposal, timeZone: string): ResolveAlertPayload {
  const windowBounds =
    proposal.action === 'move_window' &&
    proposal.windowDate &&
    proposal.windowStartLocal &&
    proposal.windowEndLocal
      ? {
          windowStartAt: localToUnixSeconds(
            proposal.windowDate,
            proposal.windowStartLocal,
            timeZone,
          ),
          windowEndAt: localToUnixSeconds(proposal.windowDate, proposal.windowEndLocal, timeZone),
        }
      : {};
  return {
    action: proposal.action,
    reason: proposal.reason,
    ...(proposal.minutes === undefined ? {} : { minutes: proposal.minutes }),
    ...windowBounds,
    ...(proposal.engineerId === undefined ? {} : { engineerId: proposal.engineerId }),
  };
}

function buildContext(input: {
  alertId: string;
  code: string;
  severity: string;
  reasons: unknown;
  restoreOption: unknown;
  request: {
    id: string;
    requiredSkill: string;
    region: string | null;
    windowStartAt: bigint;
    windowEndAt: bigint;
    lifecycle: string;
  } | null;
  engineerDays: Array<{ engineerId: string; availability: string; workDate: string }>;
  candidates: readonly AddEngineerCandidate[];
  routeLegs: readonly string[];
  allowed: readonly AlertAction[];
}): string {
  const lines = [
    `Алерт ${input.alertId}, код "${input.code}", важность "${input.severity}".`,
    `Разрешённые действия (полный список, другие недопустимы): ${input.allowed.join(', ')}.`,
    `Причины (сырые данные решателя): ${JSON.stringify(input.reasons)}`,
    `restoreOption: ${input.restoreOption ? JSON.stringify(input.restoreOption) : 'null (восстановление невозможно)'}`,
  ];
  if (input.request) {
    lines.push(
      `Связанная заявка ${input.request.id}: lifecycle=${input.request.lifecycle}, навык=${input.request.requiredSkill}, регион=${input.request.region ?? 'нет'}, окно=${input.request.windowStartAt}-${input.request.windowEndAt}.`,
    );
  }
  if (input.engineerDays.length > 0) {
    lines.push(
      `Инженеры дня: ${input.engineerDays.map((day) => `${day.engineerId} (${day.availability})`).join('; ')}.`,
    );
  }
  if (input.candidates.length > 0) {
    lines.push(
      `Кандидаты на add_engineer (единственно допустимые engineerId для этого действия): ${input.candidates
        .map(
          (item) =>
            `${item.engineerId} (${item.displayName}, регион ${item.region ?? 'нет'}, навыки ${item.skills.join(',')})`,
        )
        .join('; ')}.`,
    );
  } else if (input.allowed.includes('add_engineer')) {
    lines.push('Кандидатов на add_engineer нет: подходящих свободных инженеров не найдено.');
  }
  if (input.routeLegs.length > 0) {
    lines.push('Дорожная обстановка по маршрутам вовлечённых инженеров:', ...input.routeLegs);
  }
  return lines.join('\n');
}

function costMicrosFor(
  promptTokens: number,
  completionTokens: number,
  config: AppConfigService,
): number {
  const perKPrompt = config.get('AI_UNITS_PER_1K_PROMPT_MICROS');
  const perKCompletion = config.get('AI_UNITS_PER_1K_COMPLETION_MICROS');
  return Math.round(
    (promptTokens / 1000) * perKPrompt + (completionTokens / 1000) * perKCompletion,
  );
}
