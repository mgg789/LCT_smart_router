import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ActionGuardService } from '../../ai/operations';
import { agentEngineerAttendance, toAgentDayView } from '../../api/agent-engineer-view';
import { toDayView, toEngineerView } from '../../api/engineer-view';
import { toPlanView } from '../../api/plan-view';
import { type RequestView, toRequestView } from '../../api/request-view';
import { weatherView } from '../../api/weather-view';
import type { Actor } from '../../auth';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import { AuditService, OperationsService } from '../../operations';
import { assertManualConflictResolved } from '../../operations/manual-conflict-guard';
import { PrismaService } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  PlanRestoreService,
  RouterClient,
} from '../../routing/router-gateway';
import { ManualDecisionsService } from '../../routing/router-gateway/manual-decisions.service';
import {
  manualDecisionSchema,
  manualStateView,
  readManualState,
} from '../../routing/router-gateway/manual-state';
import { AlertsService, type ResolveAlertInput } from '../alerts';
import { LiveService } from '../live';
import { PolicyService } from '../policy';
import {
  parsePersonalObjectiveOrder,
  personalPolicyPresetSchema,
  personalPolicyToolSchema,
} from '../policy/personal-policy';
import { commitPolicyRouterPreset } from '../policy/personal-policy-preset';
import { resolveRequestReference } from '../requests/request-reference';
import { DispatcherSettingsService } from '../settings';
import {
  rememberSimulation,
  russianDelta,
  type SimulationPatchInput,
  toRouterPatch,
} from '../simulator/simulation-store';
import { McpService } from './mcp.service';
import { ROUTING_PRINCIPLES } from './mcp-principles';
import { type McpToolDefinition } from './mcp-protocol';

/**
 * The MCP tool registry: every capability the dispatcher's agent gets, one entry each.
 *
 * Tools are thin adapters over the same services the dashboard controllers use — a rule
 * lives in exactly one handler, and an agent cannot grow a diverging version of it. Reads
 * return the dashboard views verbatim; writes go through [[OperationsService.execute]]
 * with a server-generated `operationId`, so a retried tool call never repeats a change.
 */

const unixSeconds = z.number().int().nonnegative();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

interface McpToolEntry {
  readonly definition: McpToolDefinition;
  readonly invoke: (args: unknown, actor: Actor) => Promise<unknown>;
}

/** Binds a JSON-Schema declaration, a zod parser and a handler into one registry entry. */
function defineTool<S extends z.ZodType>(
  definition: McpToolDefinition,
  args: S,
  handle: (args: z.infer<S>, actor: Actor) => Promise<unknown>,
): McpToolEntry {
  return {
    definition,
    invoke: (raw, actor) => {
      const parsed = args.safeParse(raw ?? {});
      if (!parsed.success) {
        throw SysError.validationFailed('Invalid tool arguments', {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      return handle(parsed.data as z.infer<S>, actor);
    },
  };
}

const routerControlArgs = z
  .object({
    lunchesEnabled: z.boolean().optional(),
    metroEnabled: z.boolean().optional(),
    trafficEnabled: z.boolean().optional(),
    equipmentEnabled: z.boolean().optional(),
    equipmentTransfersEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'Name at least one toggle',
  });

const whatIfArgs = z
  .object({
    catalog: z.boolean().optional(),
    policyId: z.enum(['fast', 'compact', 'sla', 'balanced', 'eco', 'covering']).optional(),
    lunchesEnabled: z.boolean().optional(),
    metroEnabled: z.boolean().optional(),
    trafficEnabled: z.boolean().optional(),
    equipmentEnabled: z.boolean().optional(),
    equipmentTransfersEnabled: z.boolean().optional(),
    bringOnlineEngineerId: z.string().min(1).max(80).optional(),
    window: z
      .object({
        requestId: z.string().min(1),
        windowStartAt: unixSeconds,
        windowEndAt: unixSeconds,
      })
      .optional(),
    pin: z
      .object({
        requestId: z.string().min(1),
        engineerId: z.string().min(1),
      })
      .optional(),
    unassignRequestId: z.string().min(1).optional(),
  })
  .strict();

const reviewArgs = whatIfArgs
  .extend({
    action: z.string().min(1).max(80),
    context: z.string().min(1).max(2_000),
  })
  .strict();

/** JSON Schema twin of {@link whatIfArgs}, without the review fields. */
const whatIfInputSchema = {
  type: 'object',
  properties: {
    catalog: {
      type: 'boolean',
      description: 'Compare every policy. Do not combine with other fields.',
    },
    policyId: { type: 'string', enum: ['fast', 'compact', 'sla', 'balanced', 'eco', 'covering'] },
    lunchesEnabled: { type: 'boolean' },
    metroEnabled: { type: 'boolean' },
    trafficEnabled: { type: 'boolean' },
    equipmentEnabled: { type: 'boolean' },
    equipmentTransfersEnabled: { type: 'boolean' },
    bringOnlineEngineerId: {
      type: 'string',
      description: 'Offline engineer id. Available on the simulation copy only.',
    },
    window: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        windowStartAt: { type: 'number' },
        windowEndAt: { type: 'number' },
      },
      required: ['requestId', 'windowStartAt', 'windowEndAt'],
    },
    pin: {
      type: 'object',
      properties: {
        requestId: { type: 'string' },
        engineerId: { type: 'string' },
      },
      required: ['requestId', 'engineerId'],
    },
    unassignRequestId: { type: 'string' },
  },
  additionalProperties: false,
} as const;

function hasWhatIf(input: SimulationPatchInput): boolean {
  return (
    input.catalog === true ||
    input.policyId !== undefined ||
    input.lunchesEnabled !== undefined ||
    input.metroEnabled !== undefined ||
    input.trafficEnabled !== undefined ||
    input.equipmentEnabled !== undefined ||
    input.equipmentTransfersEnabled !== undefined ||
    input.bringOnlineEngineerId !== undefined ||
    input.window !== undefined ||
    input.pin !== undefined ||
    input.unassignRequestId !== undefined
  );
}

const dispatcherSettingsPatchArgs = z
  .object({
    dayStartMin: z.number().int().min(0).max(1440).optional(),
    dayEndMin: z.number().int().min(0).max(1440).optional(),
    fiveTwoStartMin: z.number().int().min(0).max(1440).optional(),
    fiveTwoEndMin: z.number().int().min(0).max(1440).optional(),
    twoTwoStartMin: z.number().int().min(0).max(1440).optional(),
    twoTwoEndMin: z.number().int().min(0).max(1440).optional(),
    noShowSec: z.number().int().min(0).max(86_400).optional(),
    overdueSec: z.number().int().min(0).max(86_400).optional(),
    timeRiskSec: z.number().int().min(0).max(86_400).optional(),
    repeatAfterSec: z.number().int().min(0).max(86_400).optional(),
    equipmentCapacityWalk: z.number().int().min(0).max(1000).optional(),
    equipmentCapacityBike: z.number().int().min(0).max(1000).optional(),
    equipmentCapacityCar: z.number().int().min(0).max(1000).optional(),
  })
  .refine((value) => value.dayEndMin === undefined || value.dayEndMin > (value.dayStartMin ?? 0), {
    message: 'The working day must end after it starts',
  });

@Injectable()
export class McpToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
    private readonly operations: OperationsService,
    private readonly audit: AuditService,
    private readonly alertsService: AlertsService,
    private readonly live: LiveService,
    private readonly policyService: PolicyService,
    private readonly dispatcherSettings: DispatcherSettingsService,
    private readonly plans: AppliedPlanService,
    private readonly restore: PlanRestoreService,
    private readonly control: ControlStateService,
    private readonly router: RouterClient,
    private readonly publisher: SnapshotPublisher,
    private readonly mcp: McpService,
    private readonly guard: ActionGuardService,
    private readonly manualDecisions: ManualDecisionsService,
  ) {}

  /** External agents use the same intent validation, CAS and operation journal as HTTP. */
  private manualTools(): McpToolEntry[] {
    const edit = manualDecisionSchema.omit({ id: true, priority: true }).extend({
      expectedVersion: z.number().int().nonnegative(),
      windowChangeConfirmation: z.string().optional(),
    });
    const remove = z.object({
      expectedVersion: z.number().int().nonnegative(),
      decisionId: z.string().min(1),
    });
    const order = z.object({
      expectedVersion: z.number().int().nonnegative(),
      decisionIds: z.array(z.string().min(1)),
    });
    return [
      defineTool(
        {
          name: 'get_manual_state',
          title: 'Ручные решения',
          description:
            'Read Manual session version, decisions and conflicts. Check mode using get_situation. New decisions tie at highest priority; smaller priority numbers win.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => manualStateView(await readManualState(this.prisma)),
      ),
      defineTool(
        {
          name: 'edit_manual_decision',
          title: 'Сохранить ручное решение',
          description:
            'Only enabled Manual: assignment, window, lunch or shift. Read current version first. Requires explicit user consent. For a changed window first receive the exact-bounds confirmation challenge, ask the user to approve those bounds, then retry with windowChangeConfirmation from that challenge. Epoch seconds use business date/time. Started work cannot be reassigned. Conflicting decisions may be rejected by planning.',
          inputSchema: {
            type: 'object',
            properties: z.toJSONSchema(edit).properties ?? {},
            required: z.toJSONSchema(edit).required,
            additionalProperties: false,
          },
        },
        edit,
        async (args, actor) => {
          const { expectedVersion, windowChangeConfirmation, ...input } = args;
          const outcome = await this.operations.execute(
            {
              operationId: randomUUID(),
              actor: { ...actor, windowChangeConfirmation },
              action: 'manual.decision.put',
              payload: { expectedVersion, ...input },
            },
            (context) => this.manualDecisions.put(context, expectedVersion, input),
          );
          return outcome.result;
        },
      ),
      defineTool(
        {
          name: 'remove_manual_decision',
          title: 'Удалить ручное решение',
          description:
            'Only enabled Manual. Remove an explicitly chosen intention using current version; actual execution is retained. Obtain user consent first.',
          inputSchema: {
            type: 'object',
            properties: z.toJSONSchema(remove).properties ?? {},
            required: z.toJSONSchema(remove).required,
            additionalProperties: false,
          },
        },
        remove,
        async (args, actor) => {
          const outcome = await this.operations.execute(
            { operationId: randomUUID(), actor, action: 'manual.decision.remove', payload: args },
            (context) =>
              this.manualDecisions.remove(context, args.expectedVersion, args.decisionId),
          );
          return outcome.result;
        },
      ),
      defineTool(
        {
          name: 'reorder_manual_priorities',
          title: 'Приоритеты ручных решений',
          description:
            'Only enabled Manual. Submit every decision ID exactly once, highest priority first, with current version. Obtain explicit user choice of priorities; rejected decisions may remain unfulfilled.',
          inputSchema: {
            type: 'object',
            properties: z.toJSONSchema(order).properties ?? {},
            required: z.toJSONSchema(order).required,
            additionalProperties: false,
          },
        },
        order,
        async (args, actor) => {
          const outcome = await this.operations.execute(
            { operationId: randomUUID(), actor, action: 'manual.priorities', payload: args },
            (context) =>
              this.manualDecisions.reorder(context, args.expectedVersion, args.decisionIds),
          );
          return outcome.result;
        },
      ),
    ];
  }

  /** Tool catalogue for `tools/list`, in registration order. */
  listTools(): readonly McpToolDefinition[] {
    return this.entries.map((entry) => entry.definition);
  }

  /** Parses arguments, marks the activity indicator and runs one tool. */
  async call(name: string, args: unknown, actor: Actor): Promise<unknown> {
    this.mcp.touch(name);
    const entry = this.entries.find((item) => item.definition.name === name);
    if (!entry) {
      throw SysError.validationFailed(`Unknown tool: ${name}`, {
        available: this.listTools().map((definition) => definition.name),
      });
    }
    return entry.invoke(args, actor);
  }

  private lazyEntries: McpToolEntry[] | null = null;

  private get entries(): McpToolEntry[] {
    this.lazyEntries ??= this.build();
    return this.lazyEntries;
  }

  private build(): McpToolEntry[] {
    const now = (): number => this.clock.nowSeconds();

    return [
      defineTool(
        {
          name: 'get_dispatcher_context',
          title: 'Контекст должности',
          description:
            'Who the agent is acting as (the single dispatcher), what the platform is, the ' +
            'current workday state and the rules an autonomous agent must follow. Call this first.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => {
          const live = await this.live.dispatchView();
          return {
            platform: ROUTING_PRINCIPLES.platform,
            dispatcher: {
              email: this.config.get('DISPATCHER_EMAIL'),
              role: 'dispatcher',
              powers: [
                'изменение условий заявок, отмена и создание',
                'доступность и смены инженеров',
                'разбор алертов (вручную или через System one)',
                'выбор политики и смена оперативных настроек',
                'переключатели решателя: обеды, метро, пробки, оборудование',
                'ручной и автоматический режим плана',
                'проверка изменений в симуляторе без записи в план',
                'старт рабочего дня и закрытие смены',
              ],
            },
            workday: {
              status: live.workday.status,
              workDate: live.workday.workDate,
              liveNow: live.workday.liveNow,
              speedFactor: live.workday.speedFactor,
              stats: live.workday.stats,
              demoStand: live.demoStand,
            },
            guidance: ROUTING_PRINCIPLES.autonomyRules,
          };
        },
      ),
      defineTool(
        {
          name: 'get_routing_principles',
          title: 'Принципы роутинга',
          description:
            'Routing goals, hard constraints, the policy catalogue and how plan explanations ' +
            'are structured. Read once before judging or changing the plan.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => ROUTING_PRINCIPLES,
      ),
      defineTool(
        {
          name: 'get_situation',
          title: 'Текущая обстановка',
          description:
            'Live situation: workday status and stats, per-engineer line states, open alerts ' +
            'summary and the Moscow weather with its traffic multiplier.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => {
          const live = await this.live.dispatchView();
          const alerts = await this.alertsService.list();
          const open = alerts.filter((alert) => alert.resolvedAt === null);
          return {
            workday: {
              status: live.workday.status,
              workDate: live.workday.workDate,
              liveNow: live.workday.liveNow,
              stats: live.workday.stats,
              calculating: live.workday.calculating,
              routerPhase: live.workday.routerPhase,
              planRevision: live.workday.planRevision,
            },
            engineers: live.engineers.map((engineer) => ({
              id: engineer.id,
              name: engineer.name,
              lineStatus: engineer.lineStatus,
              availability: engineer.availability,
              attendance: agentEngineerAttendance(engineer),
              routeState: engineer.routeState,
              activeRequestId: engineer.activeRequestId,
              canFinishDay: engineer.canFinishDay,
            })),
            openAlerts: open.map((alert) => ({
              id: alert.id,
              kind: alert.kind,
              code: alert.code,
              severity: alert.severity,
              requestIds: alert.requestIds,
              engineerIds: alert.engineerIds,
              createdAt: alert.createdAt,
            })),
            weather: await this.weather(),
          };
        },
      ),
      defineTool(
        {
          name: 'get_plan',
          title: 'Текущий план',
          description:
            'The applied working plan: routes per engineer with stops and legs (schedule, ' +
            'distance, travel time) plus the request-level assignment list. Geometry polylines ' +
            'are omitted unless withGeometry is true.',
          inputSchema: {
            type: 'object',
            properties: {
              withGeometry: {
                type: 'boolean',
                description: 'Include leg polylines (large). Default false.',
              },
            },
            additionalProperties: false,
          },
        },
        z.object({ withGeometry: z.boolean().optional() }),
        async (args) => {
          const plan = await this.plans.current(this.prisma);
          const control = await this.control.current(this.prisma);
          if (!plan) {
            return { mode: control.mode, modeVersion: control.modeVersion, plan: null };
          }
          const view = toPlanView(plan);
          const planView =
            args.withGeometry === true
              ? view
              : {
                  ...view,
                  routes: view.routes.map((route) => ({
                    ...route,
                    legs: route.legs.map((leg) => {
                      const { geometry: _geometry, segments: _segments, ...rest } = leg;
                      return { ...rest, geometry: null };
                    }),
                  })),
                };
          return { mode: control.mode, modeVersion: control.modeVersion, plan: planView };
        },
      ),
      defineTool(
        {
          name: 'get_previous_plan',
          title: 'Предыдущий план',
          description:
            'Current plan, its immediate predecessor and the precise server-calculated restore ' +
            'eligibility. Read this before restore_previous_plan.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => {
          const pair = await this.restore.previous(
            { tx: this.prisma, now: now() },
            await this.router.getActiveContextVersion(),
          );
          return {
            current: pair.current ? toPlanView(pair.current) : null,
            previous: pair.previous ? toPlanView(pair.previous) : null,
            eligibility: pair.eligibility,
          };
        },
      ),
      defineTool(
        {
          name: 'restore_previous_plan',
          title: 'Восстановить предыдущий план',
          description:
            'Restore the immediate predecessor as a new revision. expectedRevision is a CAS ' +
            'fence from get_previous_plan. Reuse operationId after an uncertain response; omit ' +
            'it only for a new intent.',
          inputSchema: {
            type: 'object',
            properties: {
              expectedRevision: { type: 'integer', minimum: 1 },
              operationId: {
                type: 'string',
                format: 'uuid',
                description: 'Optional caller idempotency key. Reuse for retries.',
              },
            },
            required: ['expectedRevision'],
            additionalProperties: false,
          },
        },
        z.object({
          expectedRevision: z.number().int().positive(),
          operationId: z.uuid().optional(),
        }),
        async (args, actor) => {
          const operationId = args.operationId ?? randomUUID();
          // Same ordering as DispatchPlanHistoryController: external Router I/O happens
          // before OperationsService starts its transaction; restore re-checks its durable
          // mutation fence and revision CAS inside that transaction.
          const contextFence = await this.restore.contextMutationFence(this.prisma);
          const activeContextVersion = await this.router.getActiveContextVersion();
          const outcome = await this.operations.execute(
            {
              operationId,
              actor,
              action: 'plan.restore',
              targetRef: String(args.expectedRevision),
              payload: { operationId, expectedRevision: args.expectedRevision },
            },
            (context) =>
              this.restore.restore(
                context,
                args.expectedRevision,
                activeContextVersion,
                contextFence,
              ),
          );
          return outcome.result;
        },
      ),
      defineTool(
        {
          name: 'get_plan_explanations',
          title: 'Подробные объяснения плана',
          description:
            'Solver evidence behind assignments: factors of the chosen variant and whyNot for ' +
            'every rejected alternative. More detailed than anything shown to a human. ' +
            'Optionally filter by request or engineer.',
          inputSchema: {
            type: 'object',
            properties: {
              requestId: { type: 'string', description: 'Only this request' },
              engineerId: { type: 'string', description: 'Only this engineer' },
            },
            additionalProperties: false,
          },
        },
        z.object({
          requestId: z.string().min(1).optional(),
          engineerId: z.string().min(1).optional(),
        }),
        async (args) => {
          const plan = await this.plans.current(this.prisma);
          if (!plan) return { explanations: [] };
          const view = toPlanView(plan);
          const explanations = view.assignments
            .filter(
              (assignment) =>
                (args.requestId === undefined || assignment.requestId === args.requestId) &&
                (args.engineerId === undefined || assignment.engineerId === args.engineerId),
            )
            .map((assignment) => ({
              requestId: assignment.requestId,
              status: assignment.status,
              engineerId: assignment.engineerId,
              reasons: assignment.reasons,
            }));
          return { explanations };
        },
      ),
      defineTool(
        {
          name: 'list_requests',
          title: 'Список заявок',
          description:
            'Requests of the day, including started, finished and cancelled, with the full ' +
            'per-request detail (window, address, durations, live assumptions).',
          inputSchema: {
            type: 'object',
            properties: {
              lifecycle: { type: 'string', description: 'Filter by lifecycle, e.g. submitted' },
              assignment: { type: 'string', description: 'Filter by assignment state' },
            },
            additionalProperties: false,
          },
        },
        z.object({
          lifecycle: z.string().min(1).optional(),
          assignment: z.string().min(1).optional(),
        }),
        async (args): Promise<{ requests: RequestView[] }> => {
          const requests = await this.prisma.request.findMany({
            where: {
              ...(args.lifecycle ? { lifecycle: args.lifecycle as never } : {}),
              ...(args.assignment ? { assignmentState: args.assignment as never } : {}),
            },
            orderBy: [{ arrivalOrder: 'asc' }, { createdAt: 'asc' }],
          });
          const live = await this.prisma.liveRequestState.findMany({
            where: { workday: { status: 'running' } },
            select: { requestId: true, assumedStartedAt: true, assumedCompletedAt: true },
          });
          const states = new Map(live.map((item) => [item.requestId, item]));
          return {
            requests: requests.map((request) =>
              toRequestView(request, states.get(request.id) ?? null),
            ),
          };
        },
      ),
      defineTool(
        {
          name: 'get_personal_policy',
          title: 'Личная политика',
          description:
            'Read authenticated dispatcher personal preferences, defaults and all nine supported objectives. No selection or mutation.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async (_args, actor) => this.policyService.personal(this.prisma, actor.accountId),
      ),
      defineTool(
        {
          name: 'save_personal_policy',
          title: 'Сохранить личную политику',
          description:
            'Show numbered nine objectives and six numbered yes/no switches. Accept contiguous or separated digit permutations; ask only missing answers, agree order and switch preset, then save. Switch presets apply only on explicit selection, never on save or after independent edits. Saving never selects the policy; changing an already-active owned profile triggers replanning. Safety and emergency/coverage priorities remain mandatory. Requires dispatcher account.',
          inputSchema: {
            type: 'object',
            properties: z.toJSONSchema(personalPolicyToolSchema).properties ?? {},
            required: ['expectedVersion', 'title', 'objectiveOrder', 'preset'],
            additionalProperties: false,
          },
        },
        personalPolicyToolSchema,
        async (args, actor) => {
          const outcome = await this.operations.execute(
            { operationId: randomUUID(), actor, action: 'policy.personal.save', payload: args },
            async (context) => {
              const result = await this.policyService.savePersonal(context, {
                ...args,
                objectiveOrder: parsePersonalObjectiveOrder(args.objectiveOrder),
              });
              if (result.activeUpdated)
                await this.publisher.publishIfChanged(
                  context.tx,
                  context.now,
                  PUBLICATION_TRIGGERS.POLICY_CHANGED,
                );
              return result;
            },
          );
          return outcome.result;
        },
      ),
      defineTool(
        {
          name: 'get_request',
          title: 'Детали заявки',
          description:
            'One request by full ID or unique visible 8-character prefix, with details and history. Use the returned full ID in mutations.',
          inputSchema: {
            type: 'object',
            properties: { requestId: { type: 'string' } },
            required: ['requestId'],
            additionalProperties: false,
          },
        },
        z.object({ requestId: z.string().min(1) }),
        async (args) => {
          const request = await resolveRequestReference(this.prisma, args.requestId);
          const live = await this.prisma.liveRequestState.findFirst({
            where: { requestId: request.id, workday: { status: 'running' } },
            select: { assumedStartedAt: true, assumedCompletedAt: true },
          });
          const history = await this.prisma.requestConditionHistory.findMany({
            where: { requestId: request.id },
            orderBy: { changedAt: 'desc' },
          });
          const actors = await this.audit.actorsFor(
            history.flatMap((entry) => (entry.operationId === null ? [] : [entry.operationId])),
          );
          return {
            request: toRequestView(request, live),
            history: history.map((entry) => ({
              changedAt: Number(entry.changedAt),
              operationId: entry.operationId,
              reason: entry.reason,
              previous: entry.previous,
              actor: entry.operationId === null ? null : (actors.get(entry.operationId) ?? null),
            })),
            asOf: now(),
          };
        },
      ),
      defineTool(
        {
          name: 'list_alerts',
          title: 'Список алертов',
          description:
            'The dispatcher decision queue: alerts and notices with reasons, allowed actions ' +
            'and resolution state. Refreshes timer-derived conditions on the way.',
          inputSchema: {
            type: 'object',
            properties: { workDate: { type: 'string', description: 'YYYY-MM-DD' } },
            additionalProperties: false,
          },
        },
        z.object({ workDate: isoDate.optional() }),
        async (args) => ({ alerts: await this.alertsService.list(args.workDate) }),
      ),
      defineTool(
        {
          name: 'resolve_alert',
          title: 'Разобрать алерт',
          description:
            'Apply one alert resolution atomically. The action must be one the alert allows ' +
            '(see the `actions` field of the list_alerts output).',
          inputSchema: {
            type: 'object',
            properties: {
              alertId: { type: 'string' },
              action: {
                type: 'string',
                description:
                  'reschedule | move_window | add_engineer | keep_manual | keep_as_is | ' +
                  'restore_auto | skip_lunch | keep_lunch | message | remove_shift | ' +
                  'message_remove | extend',
              },
              reason: { type: 'string', description: 'Why this resolution was chosen' },
              minutes: {
                type: 'number',
                description: 'Minutes for reschedule/extend-like actions',
              },
              windowStartAt: { type: 'number', description: 'Unix seconds, for move_window' },
              windowEndAt: { type: 'number', description: 'Unix seconds, for move_window' },
              expectedRequestVersion: { type: 'number' },
              engineerId: { type: 'string', description: 'Target engineer for add_engineer' },
            },
            required: ['alertId', 'action'],
            additionalProperties: false,
          },
        },
        z.object({
          alertId: z.string().min(1),
          action: z.enum([
            'reschedule',
            'move_window',
            'add_engineer',
            'keep_manual',
            'keep_as_is',
            'restore_auto',
            'skip_lunch',
            'keep_lunch',
            'message',
            'remove_shift',
            'message_remove',
            'extend',
          ]),
          reason: z.string().trim().min(1).max(2_000).optional(),
          minutes: z.number().int().min(1).max(240).optional(),
          windowStartAt: unixSeconds.optional(),
          windowEndAt: unixSeconds.optional(),
          expectedRequestVersion: z.number().int().positive().optional(),
          engineerId: z.string().min(1).optional(),
        }),
        async (args, actor) => {
          const input: ResolveAlertInput = {
            action: args.action,
            ...(args.reason === undefined ? {} : { reason: args.reason }),
            ...(args.minutes === undefined ? {} : { minutes: args.minutes }),
            ...(args.windowStartAt === undefined ? {} : { windowStartAt: args.windowStartAt }),
            ...(args.windowEndAt === undefined ? {} : { windowEndAt: args.windowEndAt }),
            ...(args.expectedRequestVersion === undefined
              ? {}
              : { expectedRequestVersion: args.expectedRequestVersion }),
            ...(args.engineerId === undefined ? {} : { engineerId: args.engineerId }),
          };
          const operationId = randomUUID();
          const outcome = await this.operations.execute(
            {
              operationId,
              actor,
              action: 'alert.resolve',
              targetRef: args.alertId,
              payload: { operationId, ...input },
            },
            (context) => this.alertsService.resolve(context, args.alertId, input),
          );
          return { alert: outcome.result };
        },
      ),
      defineTool(
        {
          name: 'ai_resolve_alert',
          title: 'AI-разбор алерта',
          description:
            'Let System one (the platform AI) pick one allowed action for the alert and apply ' +
            'it through the usual resolve. Refused when the alert is already handled.',
          inputSchema: {
            type: 'object',
            properties: { alertId: { type: 'string' } },
            required: ['alertId'],
            additionalProperties: false,
          },
        },
        z.object({ alertId: z.string().min(1) }),
        async (args, actor) => this.alertsService.resolveWithSystemOne(actor, args.alertId),
      ),
      defineTool(
        {
          name: 'list_engineers',
          title: 'Список инженеров',
          description:
            'Engineers with the current LIVE working day, skills, shift and equipment. ' +
            'Planning availability=online does NOT mean checked in. Use attendance.isOnLine/label.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => {
          const live = await this.live.dispatchView();
          const engineers = await this.prisma.engineer.findMany({
            where: { archivedAt: null },
            orderBy: { inputOrder: 'asc' },
            include: {
              account: { select: { email: true } },
              days: { where: { workDate: live.workday.workDate }, take: 1 },
            },
          });
          return {
            engineers: engineers.map((engineer) => ({
              ...toEngineerView(engineer),
              day: engineer.days[0]
                ? toAgentDayView(engineer.days[0], this.config.get('APP_TIME_ZONE'))
                : null,
              attendance: agentEngineerAttendance(
                live.engineers.find((state) => state.id === engineer.id),
              ),
            })),
          };
        },
      ),
      defineTool(
        {
          name: 'set_engineer_availability',
          title: 'Доступность инженера',
          description:
            'Take an engineer off the line (offline, optionally with an expected return) or ' +
            'put them back on (online). Running work is not reassigned by this call.',
          inputSchema: {
            type: 'object',
            properties: {
              engineerId: { type: 'string' },
              availability: { type: 'string', description: 'online | offline' },
              expectedOnlineAt: { type: 'number', description: 'Unix seconds, offline only' },
            },
            required: ['engineerId', 'availability'],
            additionalProperties: false,
          },
        },
        z.object({
          engineerId: z.string().min(1),
          availability: z.enum(['online', 'offline']),
          expectedOnlineAt: unixSeconds.nullish(),
        }),
        async (args, actor) => {
          const operationId = randomUUID();
          const outcome = await this.operations.execute(
            {
              operationId,
              actor,
              action: 'engineer.set_availability',
              targetRef: args.engineerId,
              payload: { operationId, ...args },
            },
            async (context) =>
              toDayView(
                await this.live.setDispatcherAvailability(
                  context,
                  args.engineerId,
                  args.availability,
                  args.expectedOnlineAt ?? null,
                ),
              ),
          );
          return { day: outcome.result };
        },
      ),
      defineTool(
        {
          name: 'get_policies',
          title: 'Каталог политик',
          description: 'Prepared policies with descriptions and the one currently in force.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async (_args, actor) => ({
          policies: await this.policyService.listFor(this.prisma, actor.accountId),
          active: await this.policyService.active(this.prisma),
        }),
      ),
      defineTool(
        {
          name: 'select_policy',
          title: 'Выбрать политику',
          description:
            'Choose a prepared policy by id (see get_policies). Republishes the planning task; ' +
            'the plan on screen changes when Router accepts the new result.',
          inputSchema: {
            type: 'object',
            properties: { policyId: { type: 'string' } },
            required: ['policyId'],
            additionalProperties: false,
          },
        },
        z.object({ policyId: z.string().min(1).max(64) }),
        async (args, actor) => {
          const operationId = randomUUID();
          let personalPreset: z.infer<typeof personalPolicyPresetSchema> | null = null;
          if (args.policyId === 'personal') {
            await assertManualConflictResolved(this.prisma, {
              operationId,
              actor,
              action: 'policy.select',
              payload: args,
            });
            const { profile } = await this.policyService.personal(this.prisma, actor.accountId);
            if (!profile) throw SysError.validationFailed('Личная политика не создана');
            personalPreset = profile.preset;
          }
          const outcome = await this.operations.execute(
            {
              operationId,
              actor,
              action: 'policy.select',
              targetRef: args.policyId,
              payload: { operationId, policyId: args.policyId },
            },
            async (context) => {
              const selected = await this.policyService.select(context, args.policyId);
              const publication = await this.publisher.publishIfChanged(
                context.tx,
                context.now,
                PUBLICATION_TRIGGERS.POLICY_CHANGED,
              );
              return { ...selected, publication };
            },
          );
          if (!outcome.replayed) {
            await commitPolicyRouterPreset({
              prisma: this.prisma,
              router: this.router,
              live: this.live,
              policyId: args.policyId,
              preset: personalPreset,
            });
          }
          return outcome.result;
        },
      ),
      defineTool(
        {
          name: 'get_dispatcher_settings',
          title: 'Оперативные настройки',
          description:
            'Dispatcher-owned settings: day clock, alert timers and equipment capacities. ' +
            'Map-provider keys are never exposed here.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => this.dispatcherSettings.view(),
      ),
      defineTool(
        {
          name: 'update_dispatcher_settings',
          title: 'Сменить настройки',
          description:
            'Replace dispatcher-owned operational settings. Omitted keys stay as they are. ' +
            'fiveTwo and twoTwo clocks rewrite today shifts of dispatcher-created engineers. ' +
            'dayStartMin and dayEndMin still move the 2/2 window when the pattern clocks are omitted.',
          inputSchema: {
            type: 'object',
            properties: {
              dayStartMin: {
                type: 'number',
                description: 'Minutes from midnight, legacy 2/2 start',
              },
              dayEndMin: { type: 'number', description: 'Minutes from midnight, legacy 2/2 end' },
              fiveTwoStartMin: {
                type: 'number',
                description: '5/2 shift start, minutes from midnight',
              },
              fiveTwoEndMin: {
                type: 'number',
                description: '5/2 shift end, minutes from midnight',
              },
              twoTwoStartMin: {
                type: 'number',
                description: '2/2 shift start, minutes from midnight',
              },
              twoTwoEndMin: { type: 'number', description: '2/2 shift end, minutes from midnight' },
              noShowSec: { type: 'number' },
              overdueSec: { type: 'number' },
              timeRiskSec: { type: 'number' },
              repeatAfterSec: { type: 'number' },
              equipmentCapacityWalk: { type: 'number' },
              equipmentCapacityBike: { type: 'number' },
              equipmentCapacityCar: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        dispatcherSettingsPatchArgs,
        async (args, actor) => {
          const operationId = randomUUID();
          const patch = {
            ...args,
            twoTwoStartMin: args.twoTwoStartMin ?? args.dayStartMin,
            twoTwoEndMin: args.twoTwoEndMin ?? args.dayEndMin,
          };
          const outcome = await this.operations.execute(
            {
              operationId,
              actor,
              action: 'dispatch.settings.replace',
              payload: { operationId, ...patch },
            },
            async (context) => this.dispatcherSettings.replace(context, patch),
          );
          return outcome.result;
        },
      ),
      defineTool(
        {
          name: 'start_workday',
          title: 'Начать рабочий день',
          description:
            'Start the LIVE workday and publish its t=0 planning task. Refused when a day is ' +
            'already running.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async (_args, actor) => {
          const operationId = randomUUID();
          const outcome = await this.operations.execute(
            { operationId, actor, action: 'live.workday.start', payload: { operationId } },
            async (context) => this.live.start(context),
          );
          return outcome.result;
        },
      ),
      defineTool(
        {
          name: 'close_shift',
          title: 'Закрыть смену',
          description:
            'Close the day. Refused while blocking alerts have no outcome — resolve them first.',
          inputSchema: {
            type: 'object',
            properties: { workDate: { type: 'string', description: 'YYYY-MM-DD' } },
            required: ['workDate'],
            additionalProperties: false,
          },
        },
        z.object({ workDate: isoDate }),
        async (args, actor) => {
          const operationId = randomUUID();
          const outcome = await this.operations.execute(
            {
              operationId,
              actor,
              action: 'shift.close',
              targetRef: args.workDate,
              payload: { operationId, workDate: args.workDate },
            },
            (context) => this.alertsService.closeShift(context, args.workDate),
          );
          return outcome.result;
        },
      ),
      defineTool(
        {
          name: 'get_router_controls',
          title: 'Переключатели решателя',
          description:
            'Router toggles the day screen uses: lunches, metro, traffic, equipment and equipment ' +
            'transfers, plus lateness tolerances. Read this before set_router_controls. ' +
            'Map keys are never included.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => {
          if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
          return this.router.getTechnicalSettings();
        },
      ),
      defineTool(
        {
          name: 'set_router_controls',
          title: 'Сменить переключатели решателя',
          description:
            'Flip one or more Router toggles and republish the plan. Omitted keys stay as they are. ' +
            'Serious change: call simulate_plan_change with the same flags, then review_action. ' +
            'If the verdict is risk, do not call this until the dispatcher accepts the likely risks. ' +
            'Fields: lunchesEnabled, metroEnabled, trafficEnabled, equipmentEnabled, equipmentTransfersEnabled.',
          inputSchema: {
            type: 'object',
            properties: {
              lunchesEnabled: { type: 'boolean' },
              metroEnabled: { type: 'boolean' },
              trafficEnabled: { type: 'boolean' },
              equipmentEnabled: { type: 'boolean' },
              equipmentTransfersEnabled: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        routerControlArgs,
        async (args, actor) => {
          if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
          const current = await this.router.getTechnicalSettings();
          const operationId = randomUUID();
          const requested = {
            operationId,
            expectedContextVersion: current.routerContextVersion,
            lunchesEnabled: args.lunchesEnabled ?? current.lunchesEnabled,
            departureLatenessToleranceSec: current.departureLatenessToleranceSec,
            taskStartLatenessToleranceSec: current.taskStartLatenessToleranceSec,
            windowLatenessToleranceSec: current.windowLatenessToleranceSec,
            trafficEnabled: args.trafficEnabled ?? current.trafficEnabled,
            metroEnabled: args.metroEnabled ?? current.metroEnabled,
            equipmentTransfersEnabled:
              args.equipmentTransfersEnabled ?? current.equipmentTransfersEnabled,
            equipmentEnabled: args.equipmentEnabled ?? current.equipmentEnabled,
            travelTimeMode: current.travelTimeMode,
            accessBufferSec: current.accessBufferSec,
            fixedTravelTimeSec: current.fixedTravelTimeSec,
            earlyFinishReplanThresholdSec: current.earlyFinishReplanThresholdSec,
            taskOverrunToleranceSec: current.taskOverrunToleranceSec,
            solveTimeLimitMs: current.solveTimeLimitMs,
            verifyTimeLimitMs: current.verifyTimeLimitMs,
            comparisonTimeLimitMs: current.comparisonTimeLimitMs,
          };
          const outcome = await this.operations.executeExternal(
            {
              operationId,
              actor,
              action: 'router.technical-settings.replace',
              targetRef: 'router-core',
              expectedVersion: null,
              payload: requested,
            },
            () => this.router.updateTechnicalSettings(requested),
          );
          return outcome.result;
        },
      ),
      ...this.manualTools(),
      defineTool(
        {
          name: 'set_control_mode',
          title: 'Ручной или автоматический план',
          description:
            'Atypical LAST RESORT mode. Before switching, explain that constraints can reduce efficiency and conflict; obtain explicit user consent. Never switch implicitly. manual enables dispatcher constraints while live routing continues; reason is mandatory. auto clears ALL manual decisions, restores original conditions and retains actual execution. ' +
            'Call review_action first. If the verdict is risk, wait for the dispatcher.',
          inputSchema: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['auto', 'manual'] },
              reason: { type: 'string', description: 'Dispatcher reason, required for manual' },
            },
            required: ['mode'],
            additionalProperties: false,
          },
        },
        z.object({
          mode: z.enum(['auto', 'manual']),
          reason: z.string().trim().min(1).max(2000).optional(),
        }),
        async (args, actor) => {
          const operationId = randomUUID();
          const outcome = await this.operations.execute(
            {
              operationId,
              actor,
              action: `control.${args.mode}`,
              payload: { operationId, mode: args.mode, reason: args.reason },
            },
            async (context) =>
              args.mode === 'manual'
                ? this.control.enterManual(context, args.reason)
                : this.control.returnToAuto(context),
          );
          return { control: outcome.result };
        },
      ),
      defineTool(
        {
          name: 'simulate_plan_change',
          title: 'Проверить изменение в симуляторе',
          description:
            'Read-only what-if. Same levers as the dashboard simulator and the optimize button: ' +
            'catalog (all policies at once), one policyId (fast, compact, sla, balanced, eco, covering), ' +
            'settings toggles, bringOnlineEngineerId (one offline engineer becomes available on the copy only), ' +
            'one window, one pin, or one unassignRequestId. Do not mix a window or pin with a policy. ' +
            'The Russian text includes assigned, unassigned, lateness, distance, transfers, engineers in work, ' +
            'and additional covering crews. A covering crew is a reserve clone, not a named person on the shift. ' +
            'Policy covering raises coverage first and may add those crews; it does not promise every request ' +
            'is assigned. Quote the numbers. Do not invent a headcount. Does not change the live plan.',
          inputSchema: whatIfInputSchema,
        },
        whatIfArgs,
        async (args) => this.previewChange(args),
      ),
      defineTool(
        {
          name: 'review_action',
          title: 'Вердикт по действию',
          description:
            'Self-check before a serious write. Send the action name, a short context, and the same ' +
            'what-if fields you would pass to simulate_plan_change. The tool compares before and after ' +
            'in the simulator, then asks the same guard the platform agent uses. ' +
            'Returns verdict allowed (Разрешено) or risk (Риск). It does not apply the action. ' +
            'Use it for policy changes, router toggles, bringing an engineer online, manual mode, ' +
            'closing a shift, and alert resolutions that move work. ' +
            'If the verdict is risk, do not apply the action until the dispatcher accepts the likely risks.',
          inputSchema: {
            type: 'object',
            properties: {
              ...whatIfInputSchema.properties,
              action: { type: 'string', description: 'Intended write, for example policy.select' },
              context: {
                type: 'string',
                description: 'Why this change, in one or two sentences',
              },
            },
            required: ['action', 'context'],
            additionalProperties: false,
          },
        },
        reviewArgs,
        async (args) => {
          const delta = hasWhatIf(args)
            ? (await this.previewChange(args)).text
            : 'Симуляция не запускалась: в аргументах нет рычага.';
          const verdict = await this.guard.review(args.action, args.context, delta);
          return {
            verdict,
            label: verdict === 'allowed' ? 'Разрешено' : 'Риск',
            delta,
            guidance:
              verdict === 'risk'
                ? 'Не применяй действие, пока диспетчер не примет вероятные риски.'
                : 'Обычное изменение. Можно применять.',
          };
        },
      ),
    ];
  }

  /**
   * Runs one simulator patch and stores the delta for the platform guard.
   * The live plan is not touched.
   */
  private async previewChange(input: SimulationPatchInput) {
    if (!this.router.isConfigured()) throw SysError.notConfigured('Router Core');
    const patch = toRouterPatch(input);
    const result = await this.router.simulate(patch);
    if (result.delta) await rememberSimulation(this.prisma, patch, result);
    return {
      text: russianDelta(patch, result),
      transfers: result.delta?.transfers ?? 0,
      before: result.delta?.before ?? null,
      after: result.delta?.after ?? null,
    };
  }

  /** Cached forecast with the traffic multiplier; degrades to "no forecast" offline. */
  private async weather() {
    if (!this.router.isConfigured()) return weatherView(null);
    try {
      return weatherView(await this.router.getWeather());
    } catch {
      return weatherView(null);
    }
  }
}
