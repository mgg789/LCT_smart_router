import { z } from 'zod';
import { toDayView, toEngineerView } from '../../api/engineer-view';
import { toPlanView } from '../../api/plan-view';
import { toRequestView } from '../../api/request-view';
import { SysError } from '../../common/errors';
import { AlertsService } from '../../orchestrator/alerts';
import { LiveService } from '../../orchestrator/live/live.service';
import { PolicyService } from '../../orchestrator/policy';
import { RequestsService } from '../../orchestrator/requests/requests.service';
import { PrismaService } from '../../persistence';
import { SnapshotBuilder } from '../../routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  RouterClient,
} from '../../routing/router-gateway';
import type { ToolContext, ToolResult, ToolSpec } from './tool.types';

export interface DispatcherReadToolDeps {
  readonly prisma: PrismaService;
  readonly live: LiveService;
  readonly plans: AppliedPlanService;
  readonly control: ControlStateService;
  readonly requests: RequestsService;
  readonly alerts: AlertsService;
  readonly policy: PolicyService;
  readonly router: RouterClient;
  readonly builder: SnapshotBuilder;
}

const skillSchema = z.enum(['local', 'connection', 'emergency']);
const availabilitySchema = z.enum(['online', 'offline']);
const lifecycleSchema = z.enum(['draft', 'submitted', 'in_progress', 'completed', 'cancelled']);
const assignmentStateSchema = z.enum(['pending', 'assigned', 'unassigned']);

function ok(summary: string, body: unknown): ToolResult {
  return { ok: true, summary, resultContent: JSON.stringify(body) };
}

const getSituationSchema = z.object({});
type GetSituationArgs = z.infer<typeof getSituationSchema>;

const getDayPlanSchema = z.object({
  /** Narrows routes and assignments to one engineer's route; omit for the whole plan. */
  engineerId: z.string().min(1).optional(),
});
type GetDayPlanArgs = z.infer<typeof getDayPlanSchema>;

const listEngineersSchema = z.object({
  region: z.string().max(120).optional(),
  availability: availabilitySchema.optional(),
  skill: skillSchema.optional(),
});
type ListEngineersArgs = z.infer<typeof listEngineersSchema>;

const listRequestsSchema = z.object({
  lifecycle: lifecycleSchema.optional(),
  assignment: assignmentStateSchema.optional(),
  region: z.string().max(120).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type ListRequestsArgs = z.infer<typeof listRequestsSchema>;

const getRequestSchema = z.object({ requestId: z.string().min(1) });
type GetRequestArgs = z.infer<typeof getRequestSchema>;

const getRequestHistorySchema = z.object({ requestId: z.string().min(1) });
type GetRequestHistoryArgs = z.infer<typeof getRequestHistorySchema>;

const listAlertsSchema = z.object({
  workDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Only currently open alerts and notices; omit to include resolved/invalidated history too. */
  openOnly: z.boolean().optional(),
});
type ListAlertsArgs = z.infer<typeof listAlertsSchema>;

const getShiftStatusSchema = z.object({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
type GetShiftStatusArgs = z.infer<typeof getShiftStatusSchema>;

const getPoliciesSchema = z.object({});
type GetPoliciesArgs = z.infer<typeof getPoliciesSchema>;

const comparePoliciesSchema = z.object({});
type ComparePoliciesArgs = z.infer<typeof comparePoliciesSchema>;

const getRouterSettingsSchema = z.object({});
type GetRouterSettingsArgs = z.infer<typeof getRouterSettingsSchema>;

const getSnapshotDiagnosticsSchema = z.object({});
type GetSnapshotDiagnosticsArgs = z.infer<typeof getSnapshotDiagnosticsSchema>;

const evaluateManualOrderSchema = z.object({
  engineerId: z.string().min(1),
  /** Full proposed order of requestIds for this engineer, not started ones only excluded
   *  by the caller -- Router scores exactly the order given. */
  requestIds: z.array(z.string().min(1)).min(1).max(50),
});
type EvaluateManualOrderArgs = z.infer<typeof evaluateManualOrderSchema>;

/**
 * The `help`-mode (and shared `fix`-mode) read catalogue.
 *
 * Twelve tools, not forty: `docs/knowledge/dispatcher-situations.md` names 54 situations,
 * but almost all of them read the same handful of shapes (the live workday, the applied
 * plan, one request, the alert queue, the policy catalogue) and differ only in how the
 * model groups or filters what came back -- grouping unassigned requests by reason code,
 * for instance, is something the model can do once it has `plan.assignments[]`, not a
 * reason for a `list_unassigned_by_reason` tool of its own. Splitting further would not
 * remove any judgment the model has to do; it would only spend more of the tool budget
 * shuttling the same rows through more round trips. Each tool below is grounded on exactly
 * one dashboard endpoint or orchestrator service, per this file's task boundary, and the
 * three correctness rules from the task brief are kept locally next to the tool each one
 * governs (`compare_policies`'s cache, `get_snapshot_diagnostics`'s stripped payload, and
 * every reason-carrying result's `basis` passthrough).
 */
export function buildDispatcherReadTools(deps: DispatcherReadToolDeps): readonly ToolSpec[] {
  const getSituation: ToolSpec<GetSituationArgs> = {
    name: 'get_situation',
    description:
      'The day at a glance: LIVE workday status, the applied plan summary, control mode ' +
      'and the open alert count. Start here before answering a general "what\'s going on" ' +
      'question.',
    schema: getSituationSchema,
    async run(): Promise<ToolResult> {
      const [live, planRow, control, alerts] = await Promise.all([
        deps.live.dispatchView(),
        deps.plans.current(deps.prisma),
        deps.control.current(deps.prisma),
        deps.alerts.list(),
      ]);
      const openAlerts = alerts.filter(
        (alert) => alert.kind === 'alert' && alert.resolvedAt === null,
      );
      const openByCode = countBy(openAlerts, (alert) => alert.code);
      const onlineCount = live.engineers.filter(
        (engineer) => engineer.availability === 'online',
      ).length;
      const plan = planRow
        ? {
            revision: planRow.revision,
            origin: planRow.origin,
            planAsOf: Number(planRow.planAsOf),
            appliedAt: Number(planRow.appliedAt),
            routeCount: planRow.routes.length,
            assignedCount: planRow.assignments.filter((a) => a.status === 'assigned').length,
            unassignedCount: planRow.assignments.filter((a) => a.status === 'unassigned').length,
            pendingCount: planRow.assignments.filter((a) => a.status === 'pending').length,
          }
        : null;
      const body = {
        workday: {
          status: live.workday.status,
          workDate: live.workday.workDate,
          requestCount: live.workday.requestCount,
          engineerCount: live.engineers.length,
          engineersOnline: onlineCount,
          stats: live.workday.stats,
        },
        control: { mode: control.mode, modeVersion: control.modeVersion },
        plan,
        openAlertCount: openAlerts.length,
        openAlertsByCode: openByCode,
      };
      return ok(
        `Workday ${live.workday.status}; ${live.workday.requestCount} requests; ` +
          `${plan ? `plan revision ${plan.revision} (${plan.origin})` : 'no applied plan yet'}; ` +
          `${openAlerts.length} open alert(s)`,
        body,
      );
    },
  };

  const getDayPlan: ToolSpec<GetDayPlanArgs> = {
    name: 'get_day_plan',
    description:
      'The applied working plan: routes, stops and every assignment with its reasons[] ' +
      '(basis, facts). Optionally narrowed to one engineer.',
    schema: getDayPlanSchema,
    async run(_ctx: ToolContext, args: GetDayPlanArgs): Promise<ToolResult> {
      const [planRow, control] = await Promise.all([
        deps.plans.current(deps.prisma),
        deps.control.current(deps.prisma),
      ]);
      if (!planRow) {
        return ok('No applied plan yet', { mode: control.mode, plan: null });
      }
      const view = toPlanView(planRow);
      const plan = args.engineerId
        ? {
            ...view,
            routes: view.routes.filter((route) => route.engineerId === args.engineerId),
            assignments: view.assignments.filter(
              (assignment) => assignment.engineerId === args.engineerId,
            ),
          }
        : view;
      return ok(
        `Plan revision ${view.revision} (${view.origin}), ${plan.assignments.length} assignment(s) shown`,
        { mode: control.mode, modeVersion: control.modeVersion, plan },
      );
    },
  };

  const listEngineers: ToolSpec<ListEngineersArgs> = {
    name: 'list_engineers',
    description:
      'Engineers with their skills, transport and current day (shift, availability, ' +
      'lunch, equipment). Filter by region, availability or skill.',
    schema: listEngineersSchema,
    async run(_ctx: ToolContext, args: ListEngineersArgs): Promise<ToolResult> {
      const engineers = await deps.prisma.engineer.findMany({
        where: { archivedAt: null, ...(args.region ? { region: args.region } : {}) },
        orderBy: { inputOrder: 'asc' },
        include: {
          account: { select: { email: true } },
          days: { orderBy: { workDate: 'desc' }, take: 1 },
        },
      });
      let views = engineers.map((engineer) => ({
        ...toEngineerView(engineer),
        day: engineer.days[0] ? toDayView(engineer.days[0]) : null,
      }));
      if (args.availability) {
        views = views.filter((view) => view.day?.availability === args.availability);
      }
      if (args.skill) {
        views = views.filter((view) => view.skills.includes(args.skill as string));
      }
      return ok(`${views.length} engineer(s)`, { engineers: views });
    },
  };

  const listRequests: ToolSpec<ListRequestsArgs> = {
    name: 'list_requests',
    description:
      'Requests of the day, including started/finished/cancelled. Filter by lifecycle, ' +
      'assignment state or region; capped at 50 rows -- narrow the filter rather than ' +
      'expecting every request of a large day back at once.',
    schema: listRequestsSchema,
    async run(_ctx: ToolContext, args: ListRequestsArgs): Promise<ToolResult> {
      const limit = args.limit ?? 20;
      const requests = await deps.prisma.request.findMany({
        where: {
          ...(args.lifecycle ? { lifecycle: args.lifecycle } : {}),
          ...(args.assignment ? { assignmentState: args.assignment } : {}),
          ...(args.region ? { region: args.region } : {}),
        },
        orderBy: [{ arrivalOrder: 'asc' }, { createdAt: 'asc' }],
        take: limit,
      });
      const views = requests.map((request) => toRequestView(request));
      return ok(`${views.length} request(s) (limit ${limit})`, { requests: views });
    },
  };

  const getRequest: ToolSpec<GetRequestArgs> = {
    name: 'get_request',
    description:
      "One request's full conditions, including its plan assignment status and reasons[] " +
      '(basis, facts) when it has one.',
    schema: getRequestSchema,
    async run(_ctx: ToolContext, args: GetRequestArgs): Promise<ToolResult> {
      const request = await deps.requests.byId(args.requestId);
      const planRow = await deps.plans.current(deps.prisma);
      const assignment = planRow?.assignments.find((item) => item.requestId === args.requestId);
      return ok(`Request ${args.requestId}: ${request.lifecycle}/${request.assignmentState}`, {
        request: toRequestView(request),
        assignment: assignment
          ? {
              status: assignment.status,
              engineerId: assignment.engineerId,
              reasons: assignment.reasons,
            }
          : null,
      });
    },
  };

  const getRequestHistory: ToolSpec<GetRequestHistoryArgs> = {
    name: 'get_request_history',
    description:
      'Previous conditions of a request -- a journal of what used to be true, not a ' +
      'second active promise. The current conditions are always in get_request, not here.',
    schema: getRequestHistorySchema,
    async run(_ctx: ToolContext, args: GetRequestHistoryArgs): Promise<ToolResult> {
      await deps.requests.byId(args.requestId);
      const entries = await deps.prisma.requestConditionHistory.findMany({
        where: { requestId: args.requestId },
        orderBy: { changedAt: 'desc' },
      });
      const history = entries.map((entry) => ({
        changedAt: Number(entry.changedAt),
        operationId: entry.operationId,
        reason: entry.reason,
        previous: entry.previous,
      }));
      return ok(`${history.length} history entry(ies)`, { history });
    },
  };

  const listAlerts: ToolSpec<ListAlertsArgs> = {
    name: 'list_alerts',
    description:
      'Alerts and notices, including reasons[] (basis, facts), restoreOption and each ' +
      "alert's own actions[] -- the exact, finite catalogue prepare_resolve_alert will " +
      "accept for that alert. Never assume a code's usual actions; read them here.",
    schema: listAlertsSchema,
    async run(_ctx: ToolContext, args: ListAlertsArgs): Promise<ToolResult> {
      const alerts = await deps.alerts.list(args.workDate);
      const filtered = args.openOnly ? alerts.filter((alert) => alert.resolvedAt === null) : alerts;
      return ok(`${filtered.length} alert(s)/notice(s)`, { alerts: filtered });
    },
  };

  const getShiftStatus: ToolSpec<GetShiftStatusArgs> = {
    name: 'get_shift_status',
    description:
      'Whether a work date is closed, and how many blocking alerts still stand between it ' +
      'and closing.',
    schema: getShiftStatusSchema,
    async run(_ctx: ToolContext, args: GetShiftStatusArgs): Promise<ToolResult> {
      const status = await deps.alerts.shiftStatus(args.workDate);
      return ok(
        status.closedAt
          ? `${args.workDate} closed`
          : `${args.workDate} open, ${status.unresolvedCount} unresolved`,
        status,
      );
    },
  };

  const getPolicies: ToolSpec<GetPoliciesArgs> = {
    name: 'get_policies',
    description: 'The prepared policy catalogue and which one is active.',
    schema: getPoliciesSchema,
    async run(): Promise<ToolResult> {
      const [policies, active] = await Promise.all([
        deps.policy.list(),
        deps.policy.active(deps.prisma),
      ]);
      return ok(`Active policy: ${active.policyId}`, { policies, active });
    },
  };

  // `compare_policies`'s cache: keyed by run, not by argument (the tool takes none), since
  // the whole point is to spend the up-to-90-second calculation at most once per run. A
  // second call in the same run returns the first call's result -- including its
  // `inputHash` -- rather than recomputing, which is also what makes the cache safe to
  // reuse across runs: the very next read from it is what tells the model whether the
  // data has moved on since (`policy-compare-request`'s own trap in the situations file).
  const comparisonCache = new Map<
    string,
    { readonly inputHash: string; readonly result: unknown }
  >();

  const comparePolicies: ToolSpec<ComparePoliciesArgs> = {
    name: 'compare_policies',
    description:
      'Compare every prepared policy and FIFO on the current planning task. Expensive -- ' +
      'up to 90 seconds on a cold snapshot -- and called at most once per run; a second ' +
      'call in the same run returns the first result again rather than recomputing.',
    schema: comparePoliciesSchema,
    async run(ctx: ToolContext): Promise<ToolResult> {
      const cached = comparisonCache.get(ctx.runId);
      if (cached) {
        return ok('Policy comparison (cached from earlier this run)', {
          ...(cached.result as Record<string, unknown>),
          cached: true,
        });
      }
      const result = await deps.router.getPolicyComparison();
      if (comparisonCache.size > 200) {
        comparisonCache.clear();
      }
      comparisonCache.set(ctx.runId, { inputHash: result.inputHash, result });
      return ok(`Compared ${result.rows.length} row(s)`, { ...result, cached: false });
    },
  };

  const getRouterSettings: ToolSpec<GetRouterSettingsArgs> = {
    name: 'get_router_settings',
    description:
      'Router-owned routing and execution controls (lateness tolerances, traffic, equipment).',
    schema: getRouterSettingsSchema,
    async run(): Promise<ToolResult> {
      const settings = await deps.router.getTechnicalSettings();
      return ok('Router technical settings', settings);
    },
  };

  const getSnapshotDiagnostics: ToolSpec<GetSnapshotDiagnosticsArgs> = {
    name: 'get_snapshot_diagnostics',
    description:
      'Diagnostics of the published planning task (counts of excluded/degraded requests ' +
      'and why). Never the raw snapshot payload -- those bytes do not leave the server.',
    schema: getSnapshotDiagnosticsSchema,
    async run(ctx: ToolContext): Promise<ToolResult> {
      const current = await deps.prisma.routingCurrent.findUnique({
        where: { id: 'singleton' },
        include: { snapshot: true },
      });
      if (!current) {
        const pending = await deps.builder.build(deps.prisma, ctx.now);
        return ok('Nothing published yet', { published: false, diagnostics: pending.diagnostics });
      }
      const live = await deps.builder.build(deps.prisma, ctx.now);
      // `payload` (the exact bytes Router hashes) is deliberately left out: raw published
      // bytes never enter a prompt (this file's task boundary, house rule #2).
      return ok('Snapshot diagnostics', {
        published: true,
        publicationId: current.snapshot.id,
        publicationSeq: current.pointerVersion,
        inputHash: current.snapshot.inputHash,
        planningAsOf: Number(current.snapshot.planningAsOf),
        trigger: current.snapshot.trigger,
        generation: current.snapshot.generation,
        diagnostics: live.diagnostics,
        diagnosticsAtPublication: current.snapshot.diagnostics,
      });
    },
  };

  const evaluateManualOrder: ToolSpec<EvaluateManualOrderArgs> = {
    name: 'evaluate_manual_order',
    description:
      'What-if: scores a proposed fixed visit order for one engineer against the current ' +
      "policy, without applying it or changing the plan on screen (Router's " +
      'evaluateManual). Use it to check a reorder idea before suggesting it.',
    schema: evaluateManualOrderSchema,
    async run(_ctx: ToolContext, args: EvaluateManualOrderArgs): Promise<ToolResult> {
      const current = await deps.prisma.routingCurrent.findUnique({
        where: { id: 'singleton' },
        include: { snapshot: true },
      });
      if (!current) {
        throw SysError.validationFailed('No published planning task to evaluate against');
      }
      const contextVersion = await deps.router.getActiveContextVersion();
      if (!contextVersion) {
        throw SysError.notConfigured('Router Core');
      }
      const evaluation = await deps.router.evaluateManual({
        input_hash: current.snapshot.inputHash,
        router_context_version: contextVersion,
        routes: { [args.engineerId]: args.requestIds },
      });
      return ok(
        evaluation.feasible
          ? `Feasible; degraded relative to the current plan: ${evaluation.degraded}`
          : 'Not feasible as proposed',
        evaluation,
      );
    },
  };

  return [
    getSituation,
    getDayPlan,
    listEngineers,
    listRequests,
    getRequest,
    getRequestHistory,
    listAlerts,
    getShiftStatus,
    getPolicies,
    comparePolicies,
    getRouterSettings,
    getSnapshotDiagnostics,
    evaluateManualOrder,
  ];
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
