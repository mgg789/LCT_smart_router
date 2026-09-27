import { z } from 'zod';
import { AppConfigService } from '../../common/config';
import { WORK_TYPE_CODES } from '../../orchestrator/requests/work-type.catalog';
import type { AiOperationService } from '../operations';
import { localDateSchema, localTimeSchema, localToUnixSeconds } from './local-time';
import type { AnyToolSpec, ToolContext, ToolResult, ToolSpec } from './tool.types';

export interface DispatcherWriteToolDeps {
  readonly aiOperations: AiOperationService;
  readonly config: AppConfigService;
}

const equipmentSchema = z.enum(['router', 'set_top_box', 'smart_speaker']);

/** The `AlertAction` catalogue minus `move_window` and `reschedule`, which have their own
 *  dedicated tools below (`prepare_move_window`, `prepare_reschedule_request`) so their
 *  window arguments can be local date/time rather than folded into one polymorphic
 *  schema (`local-time.ts`'s own rule against a raw epoch argument). */
const genericAlertActionSchema = z.enum([
  'add_engineer',
  'keep_manual',
  'restore_auto',
  'skip_lunch',
  'keep_lunch',
  'message',
  'remove_shift',
  'message_remove',
  'make_passive',
  'prioritize',
  'extend',
]);

function prepared(op: {
  operationId: string;
  state: string;
  preview: unknown;
  guard?: string;
}): ToolResult {
  const note =
    op.guard === 'user_allowed'
      ? 'Гуард отклонил действие, диспетчер разрешил. Действие выполнено.'
      : op.guard === 'user_rejected'
        ? 'Действие отклонено совместным решением гуарда и диспетчера.'
        : op.state === 'applied'
          ? 'Действие выполнено.'
          : 'Действие не выполнено.';
  return {
    ok: op.state === 'applied',
    summary: note,
    resultContent: JSON.stringify({
      operation_id: op.operationId,
      state: op.state,
      preview: op.preview,
      note,
    }),
  };
}

const prepareMoveWindowSchema = z.object({
  /** The `time_risk`/`unassigned` alert this window change answers -- found with
   *  `list_alerts`. Window changes made outside an open alert go through
   *  `prepare_update_request` instead. */
  alertId: z.string().min(1),
  windowDate: localDateSchema,
  windowStartLocal: localTimeSchema,
  windowEndLocal: localTimeSchema,
  reason: z.string().trim().min(1).max(2_000).optional(),
});
type PrepareMoveWindowArgs = z.infer<typeof prepareMoveWindowSchema>;

const prepareRescheduleRequestSchema = z.object({
  /** The alert this reschedule answers. The server moves the request's window exactly
   *  one calendar day forward at the same time of day -- it is computed from the
   *  request's own current window, never invented here. */
  alertId: z.string().min(1),
  reason: z.string().trim().min(1).max(2_000).optional(),
});
type PrepareRescheduleRequestArgs = z.infer<typeof prepareRescheduleRequestSchema>;

const prepareUpdateRequestSchema = z
  .object({
    requestId: z.string().min(1),
    windowDate: localDateSchema.optional(),
    windowStartLocal: localTimeSchema.optional(),
    windowEndLocal: localTimeSchema.optional(),
    addressText: z.string().trim().min(1).max(500).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    urgent: z.boolean().optional(),
    requiredEquipment: equipmentSchema.optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      (value.windowDate === undefined) === (value.windowStartLocal === undefined) &&
      (value.windowDate === undefined) === (value.windowEndLocal === undefined),
    { message: 'A window change needs the date and both local times together' },
  )
  .refine(
    (value) =>
      value.windowDate !== undefined ||
      value.addressText !== undefined ||
      value.lat !== undefined ||
      value.lon !== undefined ||
      value.urgent !== undefined ||
      value.requiredEquipment !== undefined,
    { message: 'Nothing to change' },
  );
type PrepareUpdateRequestArgs = z.infer<typeof prepareUpdateRequestSchema>;

const prepareCancelRequestSchema = z.object({
  requestId: z.string().min(1),
  reason: z.string().trim().max(2_000).optional(),
  expectedVersion: z.number().int().positive().optional(),
});
type PrepareCancelRequestArgs = z.infer<typeof prepareCancelRequestSchema>;

const prepareCreateRequestSchema = z.object({
  /** The customer this request is created for, by address -- the object of this write,
   *  never the dispatcher's own subject (`ai-action.catalog.ts`'s own note on this). */
  clientEmail: z.email(),
  contactName: z.string().trim().min(1).max(200),
  addressText: z.string().trim().min(1).max(500),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  workType: z.enum(WORK_TYPE_CODES as [string, ...string[]]),
  windowDate: localDateSchema,
  windowStartLocal: localTimeSchema,
  windowEndLocal: localTimeSchema,
  urgent: z.boolean(),
  requiredEquipment: equipmentSchema.optional(),
  problemText: z.string().trim().max(2_000).optional(),
});
type PrepareCreateRequestArgs = z.infer<typeof prepareCreateRequestSchema>;

const prepareSelectPolicySchema = z.object({
  policyId: z.string().min(1).max(64),
});
type PrepareSelectPolicyArgs = z.infer<typeof prepareSelectPolicySchema>;

const prepareSetEngineerAvailabilitySchema = z.object({
  /** The engineer to change -- always someone other than the dispatcher, since the
   *  dispatcher has no engineer profile of its own (tool.types.ts's subject rule is
   *  about the *acting* party, not the object a dispatcher action names). */
  engineerId: z.string().min(1),
  availability: z.enum(['online', 'offline']),
});
type PrepareSetEngineerAvailabilityArgs = z.infer<typeof prepareSetEngineerAvailabilitySchema>;

const prepareSetEngineerWorkdaySchema = z
  .object({
    engineerId: z.string().min(1),
    workDate: localDateSchema,
    shiftStartLocal: localTimeSchema,
    shiftEndLocal: localTimeSchema,
    lunchEnabled: z.boolean().optional(),
    lunchDurationMinutes: z.number().int().positive().max(180).optional(),
    lunchWindowStartLocal: localTimeSchema.optional(),
    lunchWindowEndLocal: localTimeSchema.optional(),
    lunchRequired: z.boolean().optional(),
    attendanceOptOut: z.boolean().optional(),
  })
  .refine(
    (value) =>
      !value.lunchEnabled ||
      (value.lunchDurationMinutes !== undefined &&
        value.lunchWindowStartLocal !== undefined &&
        value.lunchWindowEndLocal !== undefined),
    { message: 'Enabling lunch needs a duration and both window bounds' },
  )
  .refine((value) => !value.lunchRequired || value.lunchEnabled, {
    message: 'A required lunch cannot also be disabled',
  });
type PrepareSetEngineerWorkdayArgs = z.infer<typeof prepareSetEngineerWorkdaySchema>;

const prepareEngineerTechnicalBreakSchema = z.object({
  engineerId: z.string().min(1),
});
type PrepareEngineerTechnicalBreakArgs = z.infer<typeof prepareEngineerTechnicalBreakSchema>;

const prepareResolveAlertSchema = z.object({
  alertId: z.string().min(1),
  action: genericAlertActionSchema,
  reason: z.string().trim().min(1).max(2_000).optional(),
  /** Only meaningful for `extend`. */
  minutes: z.number().int().min(1).max(240).optional(),
  /** Only meaningful for `add_engineer` -- the engineer object being called in, never
   *  the dispatcher's own subject. */
  engineerId: z.string().min(1).optional(),
});
type PrepareResolveAlertArgs = z.infer<typeof prepareResolveAlertSchema>;

const prepareMarkAlertSeenSchema = z.object({
  alertId: z.string().min(1),
});
type PrepareMarkAlertSeenArgs = z.infer<typeof prepareMarkAlertSeenSchema>;

const prepareCloseShiftSchema = z.object({
  workDate: localDateSchema,
});
type PrepareCloseShiftArgs = z.infer<typeof prepareCloseShiftSchema>;

const prepareRestorePreviousPlanSchema = z.object({
  expectedRevision: z.number().int().positive(),
});
type PrepareRestorePreviousPlanArgs = z.infer<typeof prepareRestorePreviousPlanSchema>;

/**
 * The `fix`-mode preparer catalogue.
 *
 * Every entry here only prepares an `AiOperation` card through `AiOperationService`; none
 * writes the domain directly (the house rule this whole module exists to keep true). Each
 * maps to exactly one entry in `ai-action.catalog.ts`, which in turn calls the same
 * orchestrator method the matching `DispatchController` HTTP handler calls -- there is
 * still exactly one vocabulary of writable actions.
 *
 * Three deliberately excluded from every AI profile, per this change's task boundary:
 * `POST /dispatch/mode` (switching emergency manual control), `plan/reassign` and
 * `plan/reorder` (editing the manual plan directly) -- `context/32` section 6.4 states the
 * AI's authority to do either is not approved yet. `data/reset`, `data/import`,
 * `data/upload`, `PUT router/technical-settings`, engineer creation/linking/unlinking,
 * `auth/tokens` and `debug/router-result` are excluded outright (see the denylist test in
 * `test/unit/ai-tools.test.ts`): destructive, credential-bearing or structural actions no
 * assistant catalogue offers in any mode. A reset in particular may be *prepared* by
 * `data.dto.ts`'s own contract, but its human confirmation phrase is never supplied by an
 * AI on the dispatcher's behalf, so it has no tool here at all rather than a tool that
 * could never actually be confirmed.
 *
 * `move_window`/`reschedule` on an alert and a direct `update_request` edit both end up as
 * a `request.update` (or, for the two alert-bound ones, `alert.resolve`) card, but are
 * kept as separate tools because they answer different dispatcher intents named in
 * `docs/knowledge/dispatcher-situations.md`'s families B/C and H, and because folding an
 * alert-bound window change and a direct one into a single schema would either lose the
 * `alertId` grounding or force local-date/time arguments to sit next to a raw epoch pair.
 */
export function buildDispatcherWriteTools(deps: DispatcherWriteToolDeps): readonly ToolSpec[] {
  const timeZone = () => deps.config.get('APP_TIME_ZONE');

  const prepareMoveWindow: ToolSpec<PrepareMoveWindowArgs> = {
    name: 'prepare_move_window',
    description:
      'Resolve a time_risk or unassigned alert by moving the request to an explicit new ' +
      'window. Needs the alertId from list_alerts or get_situation.',
    schema: prepareMoveWindowSchema,
    async run(ctx: ToolContext, args: PrepareMoveWindowArgs): Promise<ToolResult> {
      const windowStartAt = localToUnixSeconds(args.windowDate, args.windowStartLocal, timeZone());
      const windowEndAt = localToUnixSeconds(args.windowDate, args.windowEndLocal, timeZone());
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'alert.resolve',
        targetRef: args.alertId,
        payload: {
          action: 'move_window',
          windowStartAt,
          windowEndAt,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        },
      });
      return prepared(op);
    },
  };

  const prepareRescheduleRequest: ToolSpec<PrepareRescheduleRequestArgs> = {
    name: 'prepare_reschedule_request',
    description:
      'Resolve a time_risk or unassigned alert by pushing the request one calendar day ' +
      'forward at the same time of day. Needs the alertId from list_alerts or get_situation.',
    schema: prepareRescheduleRequestSchema,
    async run(ctx: ToolContext, args: PrepareRescheduleRequestArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'alert.resolve',
        targetRef: args.alertId,
        payload: {
          action: 'reschedule',
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        },
      });
      return prepared(op);
    },
  };

  const prepareUpdateRequest: ToolSpec<PrepareUpdateRequestArgs> = {
    name: 'prepare_update_request',
    description:
      'Directly change the conditions of a request that has not started yet: window, ' +
      'address, coordinates, urgency or required equipment. Not tied to an alert -- for ' +
      'resolving a specific alert use prepare_move_window, prepare_reschedule_request or ' +
      'prepare_resolve_alert instead.',
    schema: prepareUpdateRequestSchema,
    async run(ctx: ToolContext, args: PrepareUpdateRequestArgs): Promise<ToolResult> {
      const hasWindow = args.windowDate !== undefined;
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'request.update',
        targetRef: args.requestId,
        payload: {
          ...(hasWindow
            ? {
                windowStartAt: localToUnixSeconds(
                  args.windowDate as string,
                  args.windowStartLocal as string,
                  timeZone(),
                ),
                windowEndAt: localToUnixSeconds(
                  args.windowDate as string,
                  args.windowEndLocal as string,
                  timeZone(),
                ),
              }
            : {}),
          ...(args.addressText === undefined ? {} : { addressText: args.addressText }),
          ...(args.lat === undefined ? {} : { lat: args.lat }),
          ...(args.lon === undefined ? {} : { lon: args.lon }),
          ...(args.urgent === undefined ? {} : { urgent: args.urgent }),
          ...(args.requiredEquipment === undefined
            ? {}
            : { requiredEquipment: args.requiredEquipment }),
          ...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion }),
        },
      });
      return prepared(op);
    },
  };

  const prepareCancelRequest: ToolSpec<PrepareCancelRequestArgs> = {
    name: 'prepare_cancel_request',
    description: 'Cancel a request that has not started yet.',
    schema: prepareCancelRequestSchema,
    async run(ctx: ToolContext, args: PrepareCancelRequestArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'request.cancel',
        targetRef: args.requestId,
        payload: {
          ...(args.reason === undefined ? {} : { reason: args.reason }),
          ...(args.expectedVersion === undefined ? {} : { expectedVersion: args.expectedVersion }),
        },
      });
      return prepared(op);
    },
  };

  const prepareCreateRequest: ToolSpec<PrepareCreateRequestArgs> = {
    name: 'prepare_create_request',
    description:
      'Create a request on behalf of a customer, identified by address. The request is ' +
      'already submitted once confirmed -- there is no separate customer confirmation step.',
    schema: prepareCreateRequestSchema,
    async run(ctx: ToolContext, args: PrepareCreateRequestArgs): Promise<ToolResult> {
      const windowStartAt = localToUnixSeconds(args.windowDate, args.windowStartLocal, timeZone());
      const windowEndAt = localToUnixSeconds(args.windowDate, args.windowEndLocal, timeZone());
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'request.create',
        targetRef: null,
        payload: {
          clientEmail: args.clientEmail,
          contactName: args.contactName,
          addressText: args.addressText,
          ...(args.lat === undefined ? {} : { lat: args.lat }),
          ...(args.lon === undefined ? {} : { lon: args.lon }),
          workType: args.workType,
          ...(args.requiredEquipment === undefined
            ? {}
            : { requiredEquipment: args.requiredEquipment }),
          windowStartAt,
          windowEndAt,
          urgent: args.urgent,
          ...(args.problemText === undefined ? {} : { problemText: args.problemText }),
        },
      });
      return prepared(op);
    },
  };

  const prepareSelectPolicy: ToolSpec<PrepareSelectPolicyArgs> = {
    name: 'prepare_select_policy',
    description:
      'Choose one of the prepared routing policies (get_policies lists them). Republishes ' +
      'the planning task; the plan on screen does not change instantly.',
    schema: prepareSelectPolicySchema,
    async run(ctx: ToolContext, args: PrepareSelectPolicyArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'policy.select',
        targetRef: args.policyId,
        payload: { policyId: args.policyId },
      });
      return prepared(op);
    },
  };

  const prepareSetEngineerAvailability: ToolSpec<PrepareSetEngineerAvailabilityArgs> = {
    name: 'prepare_set_engineer_availability',
    description:
      "Take an engineer off the line, or put them back on -- the dispatcher's own control, " +
      'distinct from the engineer changing their own status.',
    schema: prepareSetEngineerAvailabilitySchema,
    async run(ctx: ToolContext, args: PrepareSetEngineerAvailabilityArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'dispatcher.engineer.set_availability',
        targetRef: args.engineerId,
        payload: { availability: args.availability },
      });
      return prepared(op);
    },
  };

  const prepareSetEngineerWorkday: ToolSpec<PrepareSetEngineerWorkdayArgs> = {
    name: 'prepare_set_engineer_workday',
    description:
      "Set an engineer's shift bounds and lunch conditions for one working day. Enabling " +
      'lunch needs a duration and both window bounds -- they are never invented.',
    schema: prepareSetEngineerWorkdaySchema,
    async run(ctx: ToolContext, args: PrepareSetEngineerWorkdayArgs): Promise<ToolResult> {
      const zone = timeZone();
      const shiftStartAt = localToUnixSeconds(args.workDate, args.shiftStartLocal, zone);
      const shiftEndAt = localToUnixSeconds(args.workDate, args.shiftEndLocal, zone);
      const lunch =
        args.lunchEnabled === undefined
          ? undefined
          : {
              enabled: args.lunchEnabled,
              durationSec:
                args.lunchDurationMinutes === undefined ? null : args.lunchDurationMinutes * 60,
              windowStartAt:
                args.lunchWindowStartLocal === undefined
                  ? null
                  : localToUnixSeconds(args.workDate, args.lunchWindowStartLocal, zone),
              windowEndAt:
                args.lunchWindowEndLocal === undefined
                  ? null
                  : localToUnixSeconds(args.workDate, args.lunchWindowEndLocal, zone),
            };
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'engineer.set_workday',
        targetRef: args.engineerId,
        payload: {
          workDate: args.workDate,
          shiftStartAt,
          shiftEndAt,
          ...(lunch === undefined ? {} : { lunch }),
          ...(args.lunchRequired === undefined ? {} : { lunchRequired: args.lunchRequired }),
          ...(args.attendanceOptOut === undefined
            ? {}
            : { attendanceOptOut: args.attendanceOptOut }),
        },
      });
      return prepared(op);
    },
  };

  const prepareEngineerTechnicalBreak: ToolSpec<PrepareEngineerTechnicalBreakArgs> = {
    name: 'prepare_engineer_technical_break',
    description:
      'Take an engineer off the line for a 15-minute technical stop, before a LIVE workday ' +
      'is running.',
    schema: prepareEngineerTechnicalBreakSchema,
    async run(ctx: ToolContext, args: PrepareEngineerTechnicalBreakArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'engineer.technical_break',
        targetRef: args.engineerId,
        payload: {},
      });
      return prepared(op);
    },
  };

  const prepareResolveAlert: ToolSpec<PrepareResolveAlertArgs> = {
    name: 'prepare_resolve_alert',
    description:
      'Resolve an alert with one of its allowed actions (add_engineer, keep_manual, ' +
      'restore_auto, skip_lunch, keep_lunch, message, remove_shift, message_remove, ' +
      "extend, make_passive, prioritize). Use prioritize only when the user explicitly says this request is definitely more important than other ordinary requests; emergencies always remain first. Replacing an existing request priority requires the dispatcher UI confirmation. The server rejects any action not in that specific alert's own catalogue " +
      '-- always read actions[] from list_alerts or get_situation first rather than ' +
      "assuming a code's usual set. For move_window or reschedule use their own tools.",
    schema: prepareResolveAlertSchema,
    async run(ctx: ToolContext, args: PrepareResolveAlertArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'alert.resolve',
        targetRef: args.alertId,
        payload: {
          action: args.action,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
          ...(args.minutes === undefined ? {} : { minutes: args.minutes }),
          ...(args.engineerId === undefined ? {} : { engineerId: args.engineerId }),
        },
      });
      return prepared(op);
    },
  };

  const prepareMarkAlertSeen: ToolSpec<PrepareMarkAlertSeenArgs> = {
    name: 'prepare_mark_alert_seen',
    description: 'Mark an alert as seen. This does not resolve it -- the condition stays open.',
    schema: prepareMarkAlertSeenSchema,
    async run(ctx: ToolContext, args: PrepareMarkAlertSeenArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'alert.mark_seen',
        targetRef: args.alertId,
        payload: {},
      });
      return prepared(op);
    },
  };

  const prepareCloseShift: ToolSpec<PrepareCloseShiftArgs> = {
    name: 'prepare_close_shift',
    description:
      'Close the shift for a work date. Only possible once every blocking alert has an ' +
      'outcome -- the server re-checks this at confirm time, not just at prepare time.',
    schema: prepareCloseShiftSchema,
    async run(ctx: ToolContext, args: PrepareCloseShiftArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'shift.close',
        targetRef: args.workDate,
        payload: { workDate: args.workDate },
      });
      return prepared(op);
    },
  };

  const prepareRestorePreviousPlan: ToolSpec<PrepareRestorePreviousPlanArgs> = {
    name: 'prepare_restore_previous_plan',
    description:
      'Prepare a human-confirmed restore of the immediate predecessor. Call get_previous_plan ' +
      'first and use its current revision; the server checks the plan and Router context again.',
    schema: prepareRestorePreviousPlanSchema,
    async run(ctx: ToolContext, args: PrepareRestorePreviousPlanArgs): Promise<ToolResult> {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'plan.restore',
        targetRef: String(args.expectedRevision),
        payload: args,
      });
      return prepared(op);
    },
  };

  return (
    [
      prepareMoveWindow,
      prepareRescheduleRequest,
      prepareUpdateRequest,
      prepareCancelRequest,
      prepareCreateRequest,
      prepareSelectPolicy,
      prepareSetEngineerAvailability,
      prepareSetEngineerWorkday,
      prepareEngineerTechnicalBreak,
      prepareResolveAlert,
      prepareMarkAlertSeen,
      prepareCloseShift,
      prepareRestorePreviousPlan,
    ] as AnyToolSpec[]
  ).map(performsNow);
}

/** The catalogue names still start with `prepare_`. The model was reading that as
 *  "this only drafts a card", then telling the dispatcher it had no write tool. */
function performsNow(tool: AnyToolSpec): AnyToolSpec {
  return {
    name: tool.name,
    description: `Performs the change on this call. ${tool.description}`,
    schema: tool.schema,
    run: (ctx, args) => tool.run(ctx, args),
  };
}
