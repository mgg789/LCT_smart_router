import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Actor } from '../../auth';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import { AiConnectionsService } from '../../orchestrator/ai/ai-connections.service';
import { PolicyService } from '../../orchestrator/policy';
// Catalog file only, not the `requests` barrel: it also loads Nest modules and can leave
// `findWorkType` undefined under CJS circular imports in unit tests (mirrors
// `ai-action.catalog.ts`'s own note on this).
import { workTypeDisplayTitle } from '../../orchestrator/requests/work-type.catalog';
import { PrismaService, UnitOfWork } from '../../persistence';
import { AppliedPlanService } from '../../routing/router-gateway/applied-plan.service';
import { RouterClient } from '../../routing/router-gateway/router-client.port';
import { LlmProvider, runProviderTurn } from '../provider';
import {
  AI_FALLBACK_PROVIDER,
  type BudgetReservation,
  BudgetService,
  ConversationService,
  RunEventBus,
  type RunHandle,
  RunRegistry,
} from '../runtime';
import {
  type CaseExplanation,
  type ExplainEngineerView,
  type ExplainPlanAssignmentView,
  type ExplainPlanLegView,
  type ExplainPlanRouteView,
  type ExplainRequestView,
  type ExplainSnapshot,
  explainSelection,
  normalizeAssignmentReasons,
} from './case-explanation';
import { EvidenceReader } from './evidence.reader';
import type { RequestEvidence } from './evidence.schema';

export interface ExplainRequestInput {
  readonly scope: 'request' | 'engineer' | 'route' | 'alert' | 'policy' | 'plan' | 'degraded';
  readonly requestId?: string;
  readonly engineerId?: string;
  readonly alertId?: string;
  readonly policyId?: string;
  readonly question?: string;
}

/**
 * System prompt of the explanation contour only. Not the assistant.
 *
 * The model restates facts the server already calculated: three or four short
 * Russian sentences, no markdown, no solver field names, no full request ids.
 * A bounded search is a limit of that search, not proof that no assignment exists.
 */
const EXPLAIN_SYSTEM_PROMPT = [
  'Ты объясняешь диспетчеру уже посчитанное решение. Решений не принимаешь.',
  'Пиши только по-русски, обычными предложениями: факт, как он повлиял, что из этого вышло.',
  'Три или четыре коротких предложения. Без списков, заголовков, звёздочек, решёток и любой разметки.',
  'Не используй внутренние коды, имена полей и служебные термины расчёта.',
  'Номер заявки — только первые 8 символов, и только если без номера фраза непонятна.',
  'Время пиши часами и минутами. Длительность — минутами. Расстояние — километрами.',
  'Не выдумывай числа, имена и причины. Если причины в контексте нет — одна фраза: в контексте причины нет.',
  'Если в контексте сказано, что поиск был ограничен, скажи, что в этом расчёте место не нашлось, и не называй это невозможностью.',
].join(' ');

/** Hard cap so an explanation stays a short paragraph even if the chat budget is larger. */
const EXPLAIN_OUTPUT_TOKEN_CAP = 280;

/**
 * Assembles the deterministic, calculation-backed context for one explanation and starts
 * a single-step, no-tool, temperature-0 run over it -- the explainer micro-agent.
 *
 * Deliberately does not reuse `AgentRuntimeService.drive()`: that loop offers the
 * conversation's full tool catalogue over up to `LLM_MAX_TOOL_STEPS` turns, which is
 * exactly the two things an explanation must never have (task brief: "single step,
 * temperature 0, no tools" -- a tool call here would let the model fetch a fact outside
 * the assembled, dispatcher-auditable context). What *is* reused is the actual shared
 * machinery: `BudgetService` for the daily quota, `ConversationService` for the durable
 * message trail, `runProviderTurn` for the identical retry/fallback policy every other
 * run gets, and the `ai_runs` row this run creates -- the existing
 * `GET /ai/runs/:id/events` SSE endpoint reads that table generically, so it streams an
 * explain run exactly as it streams a chat run, with no change of its own.
 */
@Injectable()
export class ExplainService {
  private readonly logger = new Logger(ExplainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
    private readonly conversations: ConversationService,
    private readonly budgets: BudgetService,
    private readonly registry: RunRegistry,
    private readonly bus: RunEventBus,
    private readonly plans: AppliedPlanService,
    private readonly policyService: PolicyService,
    private readonly router: RouterClient,
    private readonly evidence: EvidenceReader,
    private readonly provider: LlmProvider,
    @Inject(AI_FALLBACK_PROVIDER) private readonly fallbackProvider: LlmProvider | null,
    @Optional() private readonly connections?: AiConnectionsService,
  ) {}

  async startExplainRun(
    actor: Actor,
    input: ExplainRequestInput,
  ): Promise<{ readonly runId: string }> {
    const accountId = requireAccount(actor);
    const context = await this.buildContext(input);
    const userText = input.question
      ? `${context}\n\nВопрос диспетчера: ${input.question}`
      : context;

    const now = this.clock.nowSeconds();
    // Runs need a conversation foreign key for their audited messages, but a short
    // explanation must never append turns to the dispatcher's open assistant lane.
    // An immediately closed, per-run conversation remains available to the run SSE
    // replay while getOrCreate() and the visible chat list ignore it.
    const conversation = await this.prisma.aiConversation.create({
      data: {
        accountId,
        role: 'dispatcher',
        roleProfile: 'dispatcher_readonly',
        createdAt: BigInt(now),
        updatedAt: BigInt(now),
        lastMessageAt: BigInt(now),
        closedAt: BigInt(now),
      },
    });
    const reservation = await this.budgets.reserve(accountId);
    const quota = await this.budgets.snapshot(accountId);
    const run = await this.prisma.aiRun.create({
      data: {
        conversationId: conversation.id,
        accountId,
        quotaDay: reservation.quotaDay,
        quotaAccountId: accountId,
        roleProfile: 'dispatcher_readonly',
        state: 'running',
        providerKind: this.provider.kind,
        model: this.connections?.current.llm.model ?? this.config.get('LLM_MODEL'),
        reservedMicros: reservation.reservedMicros,
        startedAt: BigInt(now),
      },
    });

    const handle = this.registry.create(run.id);
    await this.bus.emit(handle, {
      type: 'run_started',
      runId: run.id,
      conversationId: conversation.id,
    });
    await this.bus.emit(handle, {
      type: 'quota',
      remainingMicros: quota.remainingMicros,
      remainingMessages: quota.remainingMessages,
      resetAt: quota.resetAt,
    });

    await this.uow.run((tx) =>
      this.conversations.appendMessage(tx, conversation.id, now, {
        author: 'user',
        kind: 'text',
        text: userText,
      }),
    );

    void this.drive(run.id, conversation.id, accountId, reservation, userText, handle).catch(
      (error: unknown) => {
        this.logger.error(
          `Unhandled failure driving explain run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );

    return { runId: run.id };
  }

  /**
   * The single-step, no-tool, temperature-0 turn. Structurally this is
   * `AgentRuntimeService.drive()` with `maxToolSteps = 1` and `tools = []` -- the tool
   * loop, and therefore any possibility of a tool call, never exists here at all.
   */
  private async drive(
    runId: string,
    conversationId: string,
    accountId: string,
    reservation: BudgetReservation,
    userText: string,
    handle: RunHandle,
  ): Promise<void> {
    const model = this.connections?.current.llm.model ?? this.config.get('LLM_MODEL');
    const maxOutputTokens = Math.min(
      this.config.get('LLM_MAX_OUTPUT_TOKENS'),
      EXPLAIN_OUTPUT_TOKEN_CAP,
    );
    const maxAttempts = this.config.get('LLM_MAX_ATTEMPTS');
    const messageId = randomUUID();

    let finalState: 'completed' | 'failed' | 'stopped' = 'completed';
    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    try {
      const retryResult = {
        current: { providerKind: this.provider.kind, usedFallback: false, attempts: 0 },
      };
      for await (const event of runProviderTurn(
        {
          model,
          system: EXPLAIN_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userText }],
          // No tools: the explainer answers only from the assembled context, never by
          // reaching for a live fact of its own (task brief).
          tools: [],
          maxOutputTokens,
          temperature: 0,
          signal: handle.abort.signal,
        },
        this.provider,
        this.fallbackProvider,
        maxAttempts,
        retryResult,
      )) {
        if (event.type === 'text_delta') {
          text += event.text;
          await this.bus.emit(handle, { type: 'message_delta', messageId, text: event.text });
        } else if (event.type === 'done') {
          promptTokens = event.usage.promptTokens;
          completionTokens = event.usage.completionTokens;
          if (event.finishReason === 'aborted') {
            finalState = 'stopped';
          }
        }
      }
      if (finalState === 'stopped') {
        await this.bus.emit(handle, { type: 'stopped', reason: handle.stopReason ?? 'user' });
      } else {
        text = plainExplanation(text);
        const messageRow = await this.uow.run((tx) =>
          this.conversations.appendMessage(tx, conversationId, this.clock.nowSeconds(), {
            author: 'assistant',
            kind: 'text',
            text,
            runId,
          }),
        );
        await this.bus.emit(handle, {
          type: 'message',
          messageId,
          messageSeq: messageRow.seq,
          kind: 'text',
          text,
          actions: [],
        });
      }
    } catch (error) {
      finalState = 'failed';
      errorCode = error instanceof SysError ? error.code : 'AI_UNAVAILABLE';
      errorMessage = error instanceof Error ? error.message : String(error);
      await this.bus.emit(handle, { type: 'error', code: errorCode, message: errorMessage });
      this.logger.warn(`Explain run ${runId} failed: ${errorMessage}`);
    }

    const costMicros = costMicrosFor(promptTokens, completionTokens, this.config);
    await this.budgets.settle(reservation, accountId, costMicros);
    await this.prisma.aiRun.update({
      where: { id: runId },
      data: {
        state: finalState,
        finishedAt: BigInt(this.clock.nowSeconds()),
        promptTokens,
        completionTokens,
        costMicros,
        errorCode,
      },
    });
    await this.bus.emit(handle, {
      type: 'run_finished',
      state: finalState,
      usage: { promptTokens, completionTokens, costMicros },
    });
    this.registry.remove(runId);
    this.bus.forget(runId);
  }

  /** Builds the deterministic, calculation-backed context text for one scope. Every
   *  branch reads only from Prisma / `EvidenceReader` / the ported `case-explanation.ts`
   *  builder -- nothing here is model-generated. */
  async buildContext(input: ExplainRequestInput): Promise<string> {
    switch (input.scope) {
      case 'request':
        return this.contextForRequest(requireId(input.requestId, 'requestId'));
      case 'engineer':
      case 'route':
        return this.contextForEngineer(requireId(input.engineerId, 'engineerId'));
      case 'alert':
        return this.contextForAlert(requireId(input.alertId, 'alertId'));
      case 'policy':
        return this.contextForPolicy(input.policyId ?? null);
      case 'plan':
        return this.contextForPlan();
      case 'degraded':
        return this.contextForDegradedPlan();
      default: {
        const exhaustive: never = input.scope;
        throw new SysError('VALIDATION_FAILED', `Unknown explain scope "${String(exhaustive)}"`);
      }
    }
  }

  private async loadSnapshot(): Promise<{
    snapshot: ExplainSnapshot;
    routerResultPayload: unknown;
  }> {
    const [engineerRows, requestRows, plan, activePolicy] = await Promise.all([
      this.prisma.engineer.findMany({
        where: { archivedAt: null },
        include: { days: { orderBy: { workDate: 'desc' }, take: 1 } },
      }),
      this.prisma.request.findMany({}),
      this.plans.current(this.prisma),
      this.policyService.active(this.prisma),
    ]);

    const engineers: ExplainEngineerView[] = engineerRows.map((engineer) => ({
      id: engineer.id,
      displayName: engineer.displayName,
      skills: engineer.skills,
      transportType: engineer.transportType,
      region: engineer.region,
      day: engineer.days[0] ? { availability: engineer.days[0].availability } : null,
    }));

    const requests: ExplainRequestView[] = requestRows.map((request) => ({
      id: request.id,
      region: request.region,
      requiredSkill: request.requiredSkill,
      windowStartAt: Number(request.windowStartAt),
      windowEndAt: Number(request.windowEndAt),
      serviceDurationSec: request.serviceDurationSec,
      workTypeTitle: workTypeDisplayTitle(request.workTypeHd),
    }));

    const routes: ExplainPlanRouteView[] = (plan?.routes ?? []).map((route) => ({
      engineerId: route.engineerId,
      distanceKm: route.distanceKm,
      travelTimeSec: route.travelTimeSec,
      assignedCount: route.assignedCount,
      stops: route.stops.map((stop) => ({
        sequence: stop.sequence,
        kind: stop.kind,
        requestId: stop.requestId,
        arrivalAt: Number(stop.arrivalAt),
        startAt: Number(stop.startAt),
        endAt: Number(stop.endAt),
      })),
      legs: legsOf(route.legs),
    }));

    const assignments: ExplainPlanAssignmentView[] = (plan?.assignments ?? []).map((item) => ({
      requestId: item.requestId,
      status: item.status,
      engineerId: item.engineerId,
      reasons: normalizeAssignmentReasons(item.reasons, item.engineerId),
    }));

    return {
      snapshot: {
        policyId: activePolicy.policyId,
        engineers,
        requests,
        plan: { plan: plan ? { routes, assignments } : null },
      },
      routerResultPayload: plan?.routerResult?.payload ?? null,
    };
  }

  private async contextForRequest(requestId: string): Promise<string> {
    const { snapshot, routerResultPayload } = await this.loadSnapshot();
    const request = snapshot.requests.find((item) => item.id === requestId) ?? null;
    if (!request) {
      throw SysError.notFound('Request', { requestId });
    }
    const assignment =
      snapshot.plan.plan?.assignments.find((item) => item.requestId === requestId) ?? null;
    const engineer = assignment?.engineerId
      ? (snapshot.engineers.find((item) => item.id === assignment.engineerId) ?? null)
      : null;
    const route = engineer
      ? (snapshot.plan.plan?.routes.find((item) => item.engineerId === engineer.id) ?? null)
      : null;

    const explanation = explainSelection(snapshot, request, assignment, engineer, route);
    const evidencePair = this.evidence.forRequest(routerResultPayload, requestId);

    return renderContext({
      title: `Заявка ${shortExplainId(requestId)}`,
      caseExplanation: explanation,
      reasons: assignment?.reasons.assignment?.factors ?? [],
      requestEvidence: evidencePair.main,
      baselineEvidence: evidencePair.baseline,
    });
  }

  private async contextForEngineer(engineerId: string): Promise<string> {
    const { snapshot } = await this.loadSnapshot();
    const engineer = snapshot.engineers.find((item) => item.id === engineerId) ?? null;
    if (!engineer) {
      throw SysError.notFound('Engineer', { engineerId });
    }
    const route = snapshot.plan.plan?.routes.find((item) => item.engineerId === engineerId) ?? null;
    const explanation = explainSelection(snapshot, null, null, engineer, route);

    return renderContext({
      title: `Инженер ${engineer.displayName}`,
      caseExplanation: explanation,
      reasons: [],
    });
  }

  private async contextForAlert(alertId: string): Promise<string> {
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) {
      throw SysError.notFound('Alert', { alertId });
    }
    const requestId = alert.requestIds[0];
    const requestContext = requestId
      ? await this.contextForRequest(requestId).catch(() => null)
      : null;

    const lines = [
      `Уведомление, важность: ${alert.severity}.`,
      `Заявки: ${alert.requestIds.map(shortExplainId).join(', ') || 'нет'}.`,
    ];
    if (requestContext) {
      lines.push('', 'Контекст связанной заявки:', requestContext);
    }
    return lines.join('\n');
  }

  private async contextForPolicy(policyId: string | null): Promise<string> {
    if (!this.router.isConfigured()) {
      return 'Сравнение политик недоступно: Router Core не настроен, показатели не рассчитывались.';
    }
    try {
      const comparison = await this.router.getPolicyComparison();
      const rows = comparison.rows
        .map((row) => {
          const roadMin = Math.round(row.metrics.travelTimeSec / 60);
          const lateMin = Math.round(row.metrics.totalLatenessSec / 60);
          return `${row.strategyId}: назначено ${row.metrics.assignedCount} из ${row.metrics.requestsTotal}, инженеров ${row.metrics.engineersUsed}, ${row.metrics.distanceKm} км, дорога ${roadMin} мин, опоздание ${lateMin} мин.`;
        })
        .join('\n');
      const focus = policyId ? `\n\nДиспетчер спрашивает про политику «${policyId}».` : '';
      return `Сравнение политик на текущей задаче:\n${rows}${focus}\nОтвет: три или четыре коротких предложения, без списков и без разметки.`;
    } catch (error) {
      return `Сравнение политик не рассчитано: ${error instanceof Error ? error.message : String(error)}.`;
    }
  }

  private async contextForPlan(): Promise<string> {
    const { snapshot } = await this.loadSnapshot();
    return renderPlanContext(snapshot);
  }

  private async contextForDegradedPlan(): Promise<string> {
    const row = await this.prisma.appState.findUnique({
      where: { key: 'alerts.manual-evaluation' },
    });
    if (!row) {
      return 'Оценка ручного плана не рассчитывалась.';
    }
    return 'Оценка ручного плана сохранена. В текст объяснения служебные поля не входят.';
  }
}

/** Renders only persisted plan facts; dry reliability probabilities are not stored here. */
export function renderPlanContext(snapshot: ExplainSnapshot): string {
  const plan = snapshot.plan.plan;
  if (!plan) return 'Применённого плана нет. Показатели плана не рассчитаны.';

  const unassigned = plan.assignments.filter(
    (assignment) => assignment.status === 'unassigned' || assignment.status === 'pending',
  );
  const assigned = plan.assignments.length - unassigned.length;
  const distanceKm = plan.routes.reduce((total, route) => total + route.distanceKm, 0);
  const travelTimeSec = plan.routes.reduce((total, route) => total + route.travelTimeSec, 0);
  const engineersUsed = plan.routes.filter((route) => route.assignedCount > 0).length;

  return [
    'Текущий применённый план. Только проверенные данные из System Layer:',
    `Активная политика: ${snapshot.policyId}.`,
    `Заявок в плане: ${plan.assignments.length}; назначено, выполняется или выполнено: ${assigned}; без назначения: ${unassigned.length}.`,
    `Инженеров с заявками: ${engineersUsed}; длина маршрутов: ${distanceKm} км; время в пути: ${Math.round(travelTimeSec / 60)} минут.`,
    unassigned.length > 0
      ? `Первые заявки без назначения: ${unassigned
          .slice(0, 10)
          .map((item) => shortExplainId(item.requestId))
          .join(', ')}.`
      : 'Заявок без назначения нет.',
    'Вероятности опозданий и оценка надёжности в этом контексте не рассчитывались; не называй их и не объясняй причину цветовой оценки.',
  ].join('\n');
}

function renderContext(input: {
  readonly title: string;
  readonly caseExplanation: CaseExplanation | null;
  readonly reasons: ReadonlyArray<{ code?: string; facts?: Record<string, unknown> }>;
  readonly requestEvidence?: RequestEvidence | null;
  readonly baselineEvidence?: RequestEvidence | null;
}): string {
  const parts: string[] = [input.title, ''];

  if (input.caseExplanation) {
    parts.push(
      `Факты: ${input.caseExplanation.facts.join(' ')}`,
      `Влияние: ${input.caseExplanation.influence}`,
      `Итог: ${input.caseExplanation.result}`,
      '',
    );
  } else {
    parts.push('Готового объяснения для этого сочетания нет.', '');
  }

  if (searchWasBounded(input)) {
    parts.push(
      'Поиск в этом расчёте был ограничен по времени. Отсутствие варианта не доказывает, что его не существует.',
      '',
    );
  }

  parts.push('Ответ: три или четыре коротких предложения по-русски, без списков и без разметки.');
  return parts.join('\n');
}

/** True when a ground is only a bounded search, not a verified rule. */
function searchWasBounded(input: {
  readonly reasons: ReadonlyArray<{ facts?: Record<string, unknown> }>;
  readonly requestEvidence?: RequestEvidence | null;
  readonly baselineEvidence?: RequestEvidence | null;
}): boolean {
  const grounds = [
    ...input.reasons.map((item) =>
      item.facts !== undefined && typeof item.facts.basis === 'string' ? item.facts.basis : null,
    ),
    ...(input.requestEvidence?.reasons ?? []).map((item) => item.basis),
    ...(input.baselineEvidence?.reasons ?? []).map((item) => item.basis),
  ];
  return grounds.includes('calculation_outcome');
}

/** First 8 characters of a UUID. Short fixture ids stay whole. */
export function shortExplainId(id: string): string {
  const trimmed = id.trim();
  return /^[0-9a-f]{8}-/i.test(trimmed) ? trimmed.slice(0, 8) : trimmed;
}

/**
 * Drops markup, full request ids and list markers from an explanation.
 * The final message replaces the live stream, so the panel shows this text.
 */
export function plainExplanation(text: string): string {
  const withoutMarkup = text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ''))
    .replace(/[*_`#>]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (id) =>
      shortExplainId(id),
    );
  return withoutMarkup
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function legsOf(raw: unknown): ExplainPlanLegView[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (item === null || typeof item !== 'object') {
      return [];
    }
    const record = item as Record<string, unknown>;
    const arrivalAt = typeof record.arrivalAt === 'number' ? record.arrivalAt : null;
    const travelTimeSec = typeof record.travelTimeSec === 'number' ? record.travelTimeSec : null;
    const distanceKm = typeof record.distanceKm === 'number' ? record.distanceKm : null;
    if (arrivalAt === null || travelTimeSec === null || distanceKm === null) {
      return [];
    }
    return [{ arrivalAt, travelTimeSec, distanceKm }];
  });
}

function requireId(value: string | undefined, field: string): string {
  if (!value) {
    throw new SysError('VALIDATION_FAILED', `This scope needs ${field}`);
  }
  return value;
}

function requireAccount(actor: Actor): string {
  if (!actor.accountId) {
    throw SysError.forbidden('An integration key has no confirmed email to own an explanation');
  }
  return actor.accountId;
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
