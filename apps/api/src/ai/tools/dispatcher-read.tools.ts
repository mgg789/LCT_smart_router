import { z } from 'zod';
import { agentEngineerAttendance, toAgentDayView } from '../../api/agent-engineer-view';
import { toEngineerView } from '../../api/engineer-view';
import { toPlanView } from '../../api/plan-view';
import { toRequestView } from '../../api/request-view';
import { SysError } from '../../common/errors';
import { AlertsService } from '../../orchestrator/alerts';
import { LiveService } from '../../orchestrator/live/live.service';
import { PolicyService } from '../../orchestrator/policy';
import { resolveRequestReference } from '../../orchestrator/requests/request-reference';
import { RequestsService } from '../../orchestrator/requests/requests.service';
import {
  readSimulation,
  rememberSimulation,
  russianDelta,
  simulationPatchHash,
  toRouterPatch,
} from '../../orchestrator/simulator';
import { PrismaService } from '../../persistence';
import { SnapshotBuilder } from '../../routing/mount-data-eng';
import {
  AppliedPlanService,
  ControlStateService,
  PlanRestoreService,
  RouterClient,
} from '../../routing/router-gateway';
import { EvidenceReader } from '../explain/evidence.reader';
import {
  runDispatcherCompareAssignments,
  runDispatcherExplainEntity,
} from './dispatcher-explanation.tools';
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
  readonly restore: PlanRestoreService;
  readonly now: () => number;
  readonly timeZone?: string;
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

const getPreviousPlanSchema = z.object({});
type GetPreviousPlanArgs = z.infer<typeof getPreviousPlanSchema>;

const getSnapshotDiagnosticsSchema = z.object({});
type GetSnapshotDiagnosticsArgs = z.infer<typeof getSnapshotDiagnosticsSchema>;

const evaluateManualOrderSchema = z.object({
  engineerId: z.string().min(1),
  /** Full proposed order of requestIds for this engineer, not started ones only excluded
   *  by the caller -- Router scores exactly the order given. */
  requestIds: z.array(z.string().min(1)).min(1).max(50),
});
type EvaluateManualOrderArgs = z.infer<typeof evaluateManualOrderSchema>;

const dispatcherEntitySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), id: z.string().min(1) }),
  z.object({ type: z.literal('route'), engineerId: z.string().min(1) }),
  z.object({ type: z.literal('leg'), legId: z.string().min(1) }),
  z.object({ type: z.literal('lunch'), engineerId: z.string().min(1) }),
  z.object({ type: z.literal('plan') }),
]);
const explainEntitySchema = z.object({
  entity: dispatcherEntitySchema,
  aspect: z.enum([
    'overview',
    'assignment',
    'window',
    'travel',
    'alternatives',
    'schedule',
    'lunch',
    'metrics',
    'policy',
  ]),
});
type ExplainEntityArgs = z.infer<typeof explainEntitySchema>;

const compareAssignmentsSchema = z
  .object({
    requestId: z.string().min(1),
    engineerIds: z.array(z.string().min(1)).min(1).max(3),
  })
  .refine((args) => new Set(args.engineerIds).size === args.engineerIds.length, {
    message: 'Engineer ids must be unique',
    path: ['engineerIds'],
  });
type CompareAssignmentsArgs = z.infer<typeof compareAssignmentsSchema>;

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
  const evidenceReader = new EvidenceReader();
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
        (engineer) => agentEngineerAttendance(engineer).isOnLine,
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
          engineersAwaitingCheckIn: live.engineers.filter(
            (engineer) => engineer.lineStatus === 'pending',
          ).length,
          engineersAvailableForPlanning: live.engineers.filter(
            (engineer) => engineer.availability === 'online',
          ).length,
          stats: live.workday.stats,
        },
        control: { mode: control.mode, modeVersion: control.modeVersion },
        engineers: live.engineers.map((engineer) => ({
          id: engineer.id,
          name: engineer.name,
          attendance: agentEngineerAttendance(engineer),
        })),
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

  const getPreviousPlan: ToolSpec<GetPreviousPlanArgs> = {
    name: 'get_previous_plan',
    description:
      'Current applied plan, its immediate predecessor and the server-calculated eligibility ' +
      'to restore it. Eligibility is checked again when a confirmation card is applied.',
    schema: getPreviousPlanSchema,
    async run(): Promise<ToolResult> {
      const pair = await deps.restore.previous(
        { tx: deps.prisma, now: deps.now() },
        await deps.router.getActiveContextVersion(),
      );
      return ok(
        pair.eligibility.eligible
          ? `Revision ${pair.current?.revision} can restore predecessor ${pair.previous?.revision}`
          : `Previous-plan restore unavailable: ${pair.eligibility.reason}`,
        {
          current: pair.current ? toPlanView(pair.current) : null,
          previous: pair.previous ? toPlanView(pair.previous) : null,
          eligibility: pair.eligibility,
        },
      );
    },
  };

  const listEngineers: ToolSpec<ListEngineersArgs> = {
    name: 'list_engineers',
    description:
      'Engineers with their skills, transport and current day (shift, availability, ' +
      'lunch, equipment) and factual attendance. availability=online means planning eligibility, ' +
      'NOT checked in. Use attendance.isOnLine/label. Filter by region, availability or skill.',
    schema: listEngineersSchema,
    async run(_ctx: ToolContext, args: ListEngineersArgs): Promise<ToolResult> {
      const live = await deps.live.dispatchView();
      const engineers = await deps.prisma.engineer.findMany({
        where: { archivedAt: null, ...(args.region ? { region: args.region } : {}) },
        orderBy: { inputOrder: 'asc' },
        include: {
          account: { select: { email: true } },
          days: { where: { workDate: live.workday.workDate }, take: 1 },
        },
      });
      let views = engineers.map((engineer) => ({
        ...toEngineerView(engineer),
        day: engineer.days[0]
          ? toAgentDayView(engineer.days[0], deps.timeZone ?? 'Europe/Moscow')
          : null,
        attendance: agentEngineerAttendance(
          live.engineers.find((state) => state.id === engineer.id),
        ),
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
      '(basis, facts) when it has one. Accepts full ID or unique visible 8-character prefix; use returned full ID for mutations.',
    schema: getRequestSchema,
    async run(_ctx: ToolContext, args: GetRequestArgs): Promise<ToolResult> {
      const request = await resolveRequestReference(deps.prisma, args.requestId);
      if (!request) throw new SysError('NOT_FOUND', 'Request was not found');
      const planRow = await deps.plans.current(deps.prisma);
      const assignment = planRow?.assignments.find((item) => item.requestId === request.id);
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
      const existing = await resolveRequestReference(deps.prisma, args.requestId);
      if (!existing) throw new SysError('NOT_FOUND', 'Request was not found');
      const entries = await deps.prisma.requestConditionHistory.findMany({
        where: { requestId: existing.id },
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

  const simulateChangeSchema = z
    .object({
      policyId: z.enum(['fast', 'compact', 'sla', 'balanced', 'eco', 'covering']).optional(),
      lunchesEnabled: z.boolean().optional(),
      metroEnabled: z.boolean().optional(),
      trafficEnabled: z.boolean().optional(),
      equipmentEnabled: z.boolean().optional(),
      equipmentTransfersEnabled: z.boolean().optional(),
      window: z
        .object({
          requestId: z.string().min(1),
          windowStartAt: z.number().int().nonnegative(),
          windowEndAt: z.number().int().nonnegative(),
        })
        .optional(),
      pin: z
        .object({
          requestId: z.string().min(1),
          engineerId: z.string().min(1),
        })
        .optional(),
      unassignRequestId: z.string().min(1).optional(),
      bringOnlineEngineerId: z.string().min(1).max(80).optional(),
    })
    .strict();
  type SimulateChangeArgs = z.infer<typeof simulateChangeSchema>;

  const simulateChange: ToolSpec<SimulateChangeArgs> = {
    name: 'simulate_change',
    description:
      'Read-only what-if against the current plan. Does not apply the change. ' +
      'One of: policyId (fast, compact, sla, balanced, eco, covering), a settings toggle ' +
      '(lunchesEnabled, metroEnabled, trafficEnabled, equipmentEnabled, equipmentTransfersEnabled), ' +
      'bringOnlineEngineerId (mark one offline engineer available on the copy only), ' +
      'one window, one pin, or one unassignRequestId. Do not mix a window with a policy. ' +
      'The Russian text states assigned, unassigned, lateness, distance, transfers, ' +
      'engineers in work, and additional covering crews. Quote those numbers. ' +
      'A covering crew is a reserve clone, not a named person on the shift. ' +
      'Policy «полное покрытие» raises coverage first and may add reserve crews; ' +
      'it does not promise every request is assigned, because skill, region, window, ' +
      'shift and equipment still apply. Do not invent a headcount the text does not state.',
    schema: simulateChangeSchema,
    async run(_ctx, args): Promise<ToolResult> {
      const patch = toRouterPatch(args);
      const current = await deps.prisma.routingCurrent.findUnique({
        where: { id: 'singleton' },
        include: { snapshot: true },
      });
      const contextVersion = await deps.router.getActiveContextVersion();
      if (!current || !contextVersion) {
        throw SysError.validationFailed('No current published task and Router version to simulate');
      }
      const patchHash = simulationPatchHash(patch);
      const stored = await readSimulation(
        deps.prisma,
        current.snapshot.inputHash,
        contextVersion,
        patchHash,
      );
      const result = stored ?? (await deps.router.simulate(patch));

      const latest = await deps.prisma.routingCurrent.findUnique({
        where: { id: 'singleton' },
        include: { snapshot: true },
      });
      const latestContextVersion = await deps.router.getActiveContextVersion();
      if (
        !latest ||
        latest.snapshot.inputHash !== current.snapshot.inputHash ||
        latestContextVersion !== contextVersion ||
        result.input_hash !== current.snapshot.inputHash ||
        result.router_context_version !== contextVersion ||
        result.patch_hash !== patchHash
      ) {
        throw SysError.validationFailed(
          'Planning data changed during the simulation; recalculate before relying on this result',
        );
      }
      if (!stored) {
        await rememberSimulation(deps.prisma, patch, result);
      }

      // Pins and removals live in the local route order. Router's bounded fallback
      // solves the unmodified assignment constraints, so its metrics cannot prove them.
      if ((args.pin || args.unassignRequestId) && result.method !== 'insertion') {
        return ok('Запрошенное изменение назначения не подтверждено расчётом.', {
          schema_version: '1.0',
          status: 'unavailable',
          method: result.method,
          change: args,
          provenance: {
            inputHash: result.input_hash,
            routerContextVersion: result.router_context_version,
            patchHash: result.patch_hash,
          },
          limitations: [
            'Общий поиск не гарантирует запрошенное закрепление или снятие назначения. Его метрики нельзя выдавать за результат этого изменения.',
          ],
        });
      }

      const text = russianDelta(patch, result);
      const limitations =
        result.method === 'bounded'
          ? ['Bounded search did not find a variant is not proof that no feasible plan exists.']
          : result.method === 'insertion'
            ? [
                'This result checks the stated local insertion or pin against the available base plan.',
              ]
            : [
                'This is a comparison of the returned policy catalogue, not a local edit simulation.',
              ];
      return ok(text, {
        schema_version: '1.0',
        status: result.delta ? 'compared' : 'catalogue',
        method: result.method,
        baseline: result.delta
          ? { kind: 'router_base_plan', counts: result.delta.before }
          : { kind: 'not_returned_for_catalogue' },
        change: { ...args, routerPatch: patch },
        delta: result.delta ?? null,
        routes: result.routes ?? [],
        strategies: result.strategies ?? [],
        provenance: {
          inputPublicationId:
            result.input_publication_id === 'stored'
              ? current.snapshot.id
              : result.input_publication_id,
          inputHash: result.input_hash,
          routerContextVersion: result.router_context_version,
          patchHash: result.patch_hash,
          cached: result.cached,
        },
        limitations,
        text,
      });
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
      'What-if: scores a proposed fixed visit order for one engineer while preserving every ' +
      'other route from the applied plan. Does not apply a change. Router compares the full ' +
      'route set with its automatic result; the result names that baseline and its snapshot ' +
      'and context versions. Use it to check a reorder idea before suggesting it.',
    schema: evaluateManualOrderSchema,
    async run(_ctx: ToolContext, args: EvaluateManualOrderArgs): Promise<ToolResult> {
      const [current, appliedPlan, contextVersion] = await Promise.all([
        deps.prisma.routingCurrent.findUnique({
          where: { id: 'singleton' },
          include: { snapshot: true },
        }),
        deps.plans.current(deps.prisma),
        deps.router.getActiveContextVersion(),
      ]);
      if (!current || !appliedPlan) {
        throw SysError.validationFailed('No published planning task to evaluate against');
      }
      if (!contextVersion) {
        throw SysError.notConfigured('Router Core');
      }

      const targetRoute = appliedPlan.routes.find((route) => route.engineerId === args.engineerId);
      if (!targetRoute) {
        throw SysError.validationFailed(
          'The selected engineer has no route in the applied plan to reorder',
        );
      }
      const originalRequestIds = targetRoute.stops.flatMap((stop) =>
        stop.kind === 'job' && stop.requestId !== null ? [stop.requestId] : [],
      );
      const originalRequestIdSet = new Set(originalRequestIds);
      const proposedRequestIds = new Set(args.requestIds);
      if (
        originalRequestIdSet.size !== originalRequestIds.length ||
        proposedRequestIds.size !== args.requestIds.length ||
        args.requestIds.length !== originalRequestIds.length ||
        originalRequestIds.some((requestId) => !proposedRequestIds.has(requestId))
      ) {
        throw SysError.validationFailed(
          'The proposed order must contain each request from this route exactly once',
        );
      }

      // Replace only the requested engineer's visit order. The other applied routes stay
      // in the Router input so `after` compares the proposal as a whole plan, not as one
      // route against an accidentally empty day.
      const routes = Object.fromEntries(
        appliedPlan.routes.map((route) => [
          route.engineerId,
          route.stops.flatMap((stop) =>
            stop.kind === 'job' && stop.requestId !== null ? [stop.requestId] : [],
          ),
        ]),
      );
      routes[args.engineerId] = args.requestIds;

      const evaluation = await deps.router.evaluateManual({
        input_hash: current.snapshot.inputHash,
        router_context_version: contextVersion,
        routes,
      });

      // Router validates the publication and context around its calculation. Re-read at
      // this boundary too, so the assistant never presents an obsolete result as current.
      const [latest, latestPlan, latestContextVersion] = await Promise.all([
        deps.prisma.routingCurrent.findUnique({
          where: { id: 'singleton' },
          include: { snapshot: true },
        }),
        deps.plans.current(deps.prisma),
        deps.router.getActiveContextVersion(),
      ]);
      if (
        !latest ||
        latest.snapshot.inputHash !== current.snapshot.inputHash ||
        !latestPlan ||
        latestPlan.revision !== appliedPlan.revision ||
        latestContextVersion !== contextVersion ||
        evaluation.input_hash !== current.snapshot.inputHash ||
        evaluation.router_context_version !== contextVersion
      ) {
        throw SysError.validationFailed(
          'Planning data changed during the evaluation; recalculate before relying on this result',
        );
      }

      const result = {
        schema_version: '1.0',
        method: 'router.manual_fixed_order',
        baseline: {
          kind: 'router_automatic_result',
          meaning: 'Router compares the proposed full route set with its automatic result.',
        },
        proposal: { engineerId: args.engineerId, requestIds: args.requestIds },
        preservedRoutes: routes,
        provenance: {
          appliedPlanRevision: appliedPlan.revision,
          inputHash: evaluation.input_hash,
          routerContextVersion: evaluation.router_context_version,
          policyId: evaluation.policy_id,
        },
        evaluation: {
          feasible: evaluation.feasible,
          degraded: evaluation.degraded,
          criterion: evaluation.criterion,
          before: evaluation.before,
          after: evaluation.after,
        },
        limitations: [
          'The before score is Router’s automatic result, not a separately evaluated copy of the displayed applied plan.',
          'This evaluates the fixed order provided; Router does not search for a better order.',
        ],
      };
      return ok(
        evaluation.feasible
          ? `Feasible; degraded relative to Router’s automatic baseline: ${evaluation.degraded}`
          : 'Not feasible as proposed',
        result,
      );
    },
  };

  const explainEntity: ToolSpec<ExplainEntityArgs> = {
    name: 'explain_entity',
    description:
      'Explain one request, route, travel leg, lunch stop or the plan for a named aspect. ' +
      'Returns source-linked factors, evidence/version provenance and a deterministic ' +
      'follow-up question link. Unsupported or stale aspects are explicitly unavailable.',
    schema: explainEntitySchema,
    async run(_ctx, args): Promise<ToolResult> {
      return runDispatcherExplainEntity(deps, evidenceReader, args);
    },
  };

  const compareAssignments: ToolSpec<CompareAssignmentsArgs> = {
    name: 'compare_assignments',
    description:
      'Compare Router-calculated candidate checks for one request and one to three engineers ' +
      'from the same current evidence package. This is compatibility and bounded route-end ' +
      'evidence, not a reassignment optimization or a ranking.',
    schema: compareAssignmentsSchema,
    async run(_ctx, args): Promise<ToolResult> {
      return runDispatcherCompareAssignments(deps, evidenceReader, args);
    },
  };

  return [
    getSituation,
    getDayPlan,
    getPreviousPlan,
    listEngineers,
    listRequests,
    getRequest,
    getRequestHistory,
    listAlerts,
    getShiftStatus,
    getPolicies,
    comparePolicies,
    simulateChange,
    getRouterSettings,
    getSnapshotDiagnostics,
    evaluateManualOrder,
    explainEntity,
    compareAssignments,
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
