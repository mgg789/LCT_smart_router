import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { toDayView, toEngineerView } from '../../api/engineer-view';
import { toPlanView } from '../../api/plan-view';
import { type RequestView, toRequestView } from '../../api/request-view';
import { weatherView } from '../../api/weather-view';
import type { Actor } from '../../auth';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import { AuditService, OperationsService } from '../../operations';
import { PrismaService } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  RouterClient,
} from '../../routing/router-gateway';
import { AlertsService, type ResolveAlertInput } from '../alerts';
import { LiveService } from '../live';
import { PolicyService } from '../policy';
import { DispatcherSettingsService } from '../settings';
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

const dispatcherSettingsPatchArgs = z
  .object({
    dayStartMin: z.number().int().min(0).max(1440).optional(),
    dayEndMin: z.number().int().min(0).max(1440).optional(),
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
    private readonly control: ControlStateService,
    private readonly router: RouterClient,
    private readonly publisher: SnapshotPublisher,
    private readonly mcp: McpService,
  ) {}

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
          name: 'get_request',
          title: 'Детали заявки',
          description: 'One request with its details and the history of previous conditions.',
          inputSchema: {
            type: 'object',
            properties: { requestId: { type: 'string' } },
            required: ['requestId'],
            additionalProperties: false,
          },
        },
        z.object({ requestId: z.string().min(1) }),
        async (args) => {
          const request = await this.prisma.request.findUnique({ where: { id: args.requestId } });
          if (!request) {
            throw SysError.notFound('Request', { requestId: args.requestId });
          }
          const live = await this.prisma.liveRequestState.findFirst({
            where: { requestId: args.requestId, workday: { status: 'running' } },
            select: { assumedStartedAt: true, assumedCompletedAt: true },
          });
          const history = await this.prisma.requestConditionHistory.findMany({
            where: { requestId: args.requestId },
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
            'Engineers with skills, transport, login state and their latest working day ' +
            '(shift, availability, lunch, equipment).',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        z.object({}),
        async () => {
          const engineers = await this.prisma.engineer.findMany({
            where: { archivedAt: null },
            orderBy: { inputOrder: 'asc' },
            include: {
              account: { select: { email: true } },
              days: { orderBy: { workDate: 'desc' }, take: 1 },
            },
          });
          return {
            engineers: engineers.map((engineer) => ({
              ...toEngineerView(engineer),
              day: engineer.days[0] ? toDayView(engineer.days[0]) : null,
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
        async () => ({
          policies: this.policyService.list(),
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
            'Moving the day clock rewrites today engineer shifts.',
          inputSchema: {
            type: 'object',
            properties: {
              dayStartMin: { type: 'number', description: 'Minutes from midnight' },
              dayEndMin: { type: 'number', description: 'Minutes from midnight' },
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
          const outcome = await this.operations.execute(
            {
              operationId,
              actor,
              action: 'dispatch.settings.replace',
              payload: { operationId, ...args },
            },
            async (context) => this.dispatcherSettings.replace(context, args),
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
    ];
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
