import { z } from 'zod';
import type { EngineerLiveView } from '../../api/live-view.types';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { LiveService } from '../../orchestrator/live/live.service';
import type { PassportsService } from '../../orchestrator/passports/passports.service';
import type { AiOperationService } from '../operations';
import { localTimeSchema, localToUnixSeconds } from './local-time';
import type { ToolContext, ToolResult, ToolSpec } from './tool.types';

export interface EngineerToolDeps {
  readonly aiOperations: AiOperationService;
  readonly live: LiveService;
  readonly passports: PassportsService;
  readonly config: AppConfigService;
}

const equipmentSchema = z.enum(['router', 'set_top_box', 'smart_speaker']);

const reportDelaySchema = z.object({
  /** Extra minutes needed, as the engineer states it. Never assumed or defaulted. */
  minutes: z.number().int().positive().max(1_440),
  note: z.string().trim().min(1).max(2_000),
});
type ReportDelayArgs = z.infer<typeof reportDelaySchema>;

const reportMissingEquipmentSchema = z.object({
  equipment: equipmentSchema,
  note: z.string().trim().min(1).max(2_000),
});
type ReportMissingEquipmentArgs = z.infer<typeof reportMissingEquipmentSchema>;

const reportCannotCompleteSchema = z.object({
  reason: z.enum(['impossible', 'other']),
  note: z.string().trim().min(1).max(2_000),
});
type ReportCannotCompleteArgs = z.infer<typeof reportCannotCompleteSchema>;

const reportEtaSchema = z.object({
  /** Local `HH:MM` arrival forecast, converted to Unix seconds on the server. */
  etaLocal: localTimeSchema,
});
type ReportEtaArgs = z.infer<typeof reportEtaSchema>;

const emptySchema = z.object({});

const changeStatusSchema = z.object({
  /** `1` to go online, `0` to go offline. Not a boolean: this mirrors the two states the
   *  underlying `Availability` enum actually has, with no third value to invent. */
  status: z.union([z.literal(0), z.literal(1)]),
});
type ChangeStatusArgs = z.infer<typeof changeStatusSchema>;

const visitContextSchema = z
  .object({
    /** Optional request the service must authorize as currently assigned to this engineer. */
    requestId: z.string().trim().min(1).optional(),
  })
  .strict();
type VisitContextArgs = z.infer<typeof visitContextSchema>;

/** The engineer's nearest current visit, resolved from the trusted session -- never a
 *  `requestId` argument a model could supply. */
async function currentRequestId(live: LiveService, engineerId: string): Promise<string> {
  const view = await live.engineerView(engineerId);
  const requestId = view.current?.request.id;
  if (!requestId) {
    throw new SysError('VALIDATION_FAILED', 'There is no current visit to report against');
  }
  return requestId;
}

/** True while the dispatcher-controlled LIVE workday is running: engineer availability
 *  then goes through `live.engineer.*` actions instead of the legacy availability
 *  endpoint (`LiveService.assertLegacyMutationAllowed`'s own doc comment). */
async function liveWorkdayRunning(live: LiveService): Promise<boolean> {
  try {
    await live.assertLegacyMutationAllowed();
    return false;
  } catch {
    return true;
  }
}

/** Every tool in this catalogue acts on the signed-in engineer; a profile that reached
 *  here without one resolved is a dispatcher bug upstream, not a business refusal. */
function requireEngineerId(ctx: ToolContext): string {
  if (!ctx.engineerId) {
    throw new SysError('VALIDATION_FAILED', 'This tool requires a signed-in engineer');
  }
  return ctx.engineerId;
}

function clock(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(seconds * 1000));
}

function equipmentLabel(value: string | null): string {
  if (value === 'router') return 'нужен роутер';
  if (value === 'set_top_box') return 'нужна приставка';
  if (value === 'smart_speaker') return 'нужна колонка';
  return 'отдельное устройство не нужно';
}

/** What the model is allowed to retell. Raw ids and epoch seconds stay out of this text. */
function routeBrief(view: EngineerLiveView, timeZone: string): string {
  const line =
    view.engineer.lineStatus === 'online'
      ? 'на линии'
      : view.engineer.lineStatus === 'technical_break'
        ? 'на техническом перерыве'
        : view.engineer.lineStatus === 'pending'
          ? 'ещё не вышел на линию'
          : 'не на линии';
  const day =
    view.workday.status === 'running'
      ? 'идёт'
      : view.workday.status === 'pending'
        ? 'ещё не начат'
        : 'закончен';
  const lines = [
    `Инженер: ${view.engineer.name}, ${line}.`,
    `День ${view.workday.workDate}, ${day}. Сейчас ${clock(view.workday.liveNow, timeZone)}.`,
  ];
  if (view.current) {
    const phase =
      view.current.phase === 'in_progress'
        ? 'уже в работе'
        : view.current.phase === 'ready_to_start'
          ? 'можно приступать, ещё не начат'
          : 'ещё не начат, ждёт своё окно';
    lines.push(
      `Ближайший визит: ${view.current.request.addressText}. ${phase}, окно ${clock(view.current.request.windowStartAt, timeZone)}–${clock(view.current.request.windowEndAt, timeZone)}. ${equipmentLabel(view.current.request.requiredEquipment)}.`,
    );
  } else {
    lines.push('Ближайшего визита нет.');
  }
  const jobs = view.route?.stops.filter((stop) => stop.kind === 'job').length ?? 0;
  if (jobs > 1) lines.push(`Дальше по маршруту ещё ${jobs - 1}.`);
  if (view.lunch) lines.push(`Обед идёт до ${clock(view.lunch.endAt, timeZone)}.`);
  else if (view.engineer.lunchInterval) {
    lines.push(
      `Обед запланирован с ${clock(view.engineer.lunchInterval.startAt, timeZone)} до ${clock(view.engineer.lunchInterval.endAt, timeZone)}.`,
    );
  }
  lines.push(
    view.current?.phase === 'in_progress'
      ? 'Технический перерыв сейчас нельзя: визит уже начат.'
      : 'Технический перерыв сейчас можно: визит ещё не начат.',
  );
  return lines.join('\n');
}

/**
 * Returns the current visit as a small, structured snapshot for follow-up support.
 * Inventory counts are deliberately absent: the engineer-facing live service exposes
 * required equipment and confirmed handoffs, not an authoritative stock ledger.
 */
function visitContext(view: EngineerLiveView, passport: unknown): Record<string, unknown> {
  const current = view.current;
  return {
    workday: {
      status: view.workday.status,
      workDate: view.workday.workDate,
      planRevision: view.workday.planRevision,
      liveNow: view.workday.liveNow,
    },
    currentVisit: current
      ? {
          requestId: current.request.id,
          requestVersion: current.request.version,
          address: current.request.addressText,
          phase: current.phase,
          requiredEquipment: current.request.requiredEquipment,
          expectedCompletionAt: current.expectedCompletionAt,
        }
      : null,
    passport,
    inventory: {
      status: 'unavailable',
      reason: 'The engineer assistant has no authorized stock-count source.',
    },
    handoffs: view.handoffs,
  };
}

function prepared(op: {
  operationId: string;
  state: string;
  preview: unknown;
  guard?: string;
}): ToolResult {
  const note =
    op.guard === 'user_allowed'
      ? 'Гуард отклонил действие, инженер разрешил. Действие выполнено.'
      : op.guard === 'user_rejected'
        ? 'Действие отклонено совместным решением гуарда и инженера.'
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

/**
 * The engineer catalogue: one tool per `liveActionSchema` member an assistant may use, so
 * an invalid combination (e.g. a delay outside a visit) is unrepresentable at the schema
 * boundary and caught again, defensively, by `ai-action.catalog.ts`'s own precheck.
 *
 * Deliberately missing `start_visit`/`finish_visit`: factual marks stay buttons in the
 * Engineer App by an explicit product decision (context/35 section 4.2); giving them to
 * the assistant needs a separate decision this change does not make.
 */
export function buildEngineerTools(deps: EngineerToolDeps): readonly ToolSpec[] {
  const reportDelay: ToolSpec<ReportDelayArgs> = {
    name: 'report_delay',
    description:
      'Report that the current visit needs extra time. Only while the visit is already ' +
      'in progress -- ask the engineer for the visit to be started first otherwise.',
    schema: reportDelaySchema,
    async run(ctx, args) {
      const engineerId = requireEngineerId(ctx);
      const requestId = await currentRequestId(deps.live, engineerId);
      const view = await deps.live.engineerView(engineerId);
      if (view.current?.phase !== 'in_progress') {
        throw new SysError(
          'VALIDATION_FAILED',
          'Report additional time only while the visit is in progress',
        );
      }
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'live.engineer.problem',
        targetRef: engineerId,
        payload: {
          requestId,
          problemKind: 'delay',
          note: args.note,
          additionalDurationSec: args.minutes * 60,
        },
      });
      return prepared(op);
    },
  };

  const reportMissingEquipment: ToolSpec<ReportMissingEquipmentArgs> = {
    name: 'report_missing_equipment',
    description:
      'Report missing equipment only when the engineer explicitly asks to register a ' +
      'blocker. With equipment transfers enabled, an active visit waits for a delivery search; ' +
      'it is cancelled only if no delivery is feasible. Otherwise this reports a terminal problem. A ' +
      'question about alternatives is not a report command.',
    schema: reportMissingEquipmentSchema,
    async run(ctx, args) {
      const engineerId = requireEngineerId(ctx);
      const requestId = await currentRequestId(deps.live, engineerId);
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'live.engineer.problem',
        targetRef: engineerId,
        payload: {
          requestId,
          problemKind: 'missing_equipment',
          note: args.note,
          missingEquipment: args.equipment,
        },
      });
      return prepared(op);
    },
  };

  const reportCannotComplete: ToolSpec<ReportCannotCompleteArgs> = {
    name: 'report_cannot_complete',
    description:
      'Report that the current visit cannot be completed. This cancels the request; use ' +
      'it only when the engineer says the work cannot be done.',
    schema: reportCannotCompleteSchema,
    async run(ctx, args) {
      const engineerId = requireEngineerId(ctx);
      const requestId = await currentRequestId(deps.live, engineerId);
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'live.engineer.problem',
        targetRef: engineerId,
        payload: { requestId, problemKind: args.reason, note: args.note },
      });
      return prepared(op);
    },
  };

  const reportEta: ToolSpec<ReportEtaArgs> = {
    name: 'report_eta',
    description: "Report the engineer's forecast arrival time for the current visit.",
    schema: reportEtaSchema,
    async run(ctx, args) {
      const engineerId = requireEngineerId(ctx);
      const view = await deps.live.engineerView(engineerId);
      const requestId = view.current?.request.id;
      if (!requestId) {
        throw new SysError('VALIDATION_FAILED', 'There is no current visit to report against');
      }
      const etaAt = localToUnixSeconds(
        view.workday.workDate,
        args.etaLocal,
        deps.config.get('APP_TIME_ZONE'),
      );
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'live.engineer.eta',
        targetRef: engineerId,
        payload: { requestId, etaAt },
      });
      return prepared(op);
    },
  };

  // `confirm_on_time` used to sit here. The LIVE contract dropped the `on_time`
  // action (docs/live.md): an engineer who is on schedule says nothing, and one
  // who is not reports an arrival time through `report_eta` above.

  const startTechnicalBreak: ToolSpec = {
    name: 'start_technical_break',
    description:
      'Start a 15-minute technical break. Allowed while the next visit is only waiting. ' +
      'Refused only when that visit is already in progress.',
    schema: emptySchema,
    async run(ctx) {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'live.engineer.break_start',
        targetRef: requireEngineerId(ctx),
        payload: {},
      });
      return prepared(op);
    },
  };

  const finishTechnicalBreak: ToolSpec = {
    name: 'finish_technical_break',
    description: 'Finish the current technical break for the signed-in engineer.',
    schema: emptySchema,
    async run(ctx) {
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'live.engineer.break_finish',
        targetRef: requireEngineerId(ctx),
        payload: {},
      });
      return prepared(op);
    },
  };

  const changeStatusTo: ToolSpec<ChangeStatusArgs> = {
    name: 'change_status_to',
    description:
      '`status: 1` to go online, `status: 0` to go offline (stand down for the rest of ' +
      'the day). While a LIVE workday is running, going online goes through the LIVE ' +
      "action spine; going offline mid-day is the dispatcher's decision, so the " +
      'assistant explains that instead of preparing a write.',
    schema: changeStatusSchema,
    async run(ctx, args) {
      const running = await liveWorkdayRunning(deps.live);
      if (running) {
        if (args.status === 0) {
          // A mid-day stand-down is deliberately not an assistant write in this
          // contour: the dispatcher takes an engineer off the line, and a device
          // goes back through the equipment handoff. Say so plainly instead of
          // preparing a write the action catalogue would always refuse.
          return {
            ok: true,
            summary: 'Offline during a live day is a dispatcher decision',
            resultContent:
              'Уйти с линии посреди рабочего дня через ассистента нельзя: снимает ' +
              'инженера с линии только диспетчер. Если дело в устройстве — сдайте ' +
              'его через сдачу оборудования и предупредите диспетчера.',
          };
        }
        const op = await deps.aiOperations.prepare({
          actor: ctx.actor,
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          action: 'live.engineer.online',
          targetRef: requireEngineerId(ctx),
          payload: {},
        });
        return prepared(op);
      }
      const op = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'engineer.set_availability',
        targetRef: requireEngineerId(ctx),
        payload: { availability: args.status === 1 ? 'online' : 'offline' },
      });
      return prepared(op);
    },
  };

  const getMyRoute: ToolSpec = {
    name: 'get_my_route',
    description:
      "Read the signed-in engineer's day. The result is already plain Russian: retell it, " +
      'do not add codes, ids or raw timestamps.',
    schema: emptySchema,
    async run(ctx) {
      const view: EngineerLiveView = await deps.live.engineerView(requireEngineerId(ctx));
      return {
        ok: true,
        summary: view.current
          ? `Current visit: request ${view.current.request.id} (${view.current.phase})`
          : 'No current visit',
        resultContent: routeBrief(view, deps.config.get('APP_TIME_ZONE')),
      };
    },
  };

  const getMyVisitContext: ToolSpec<VisitContextArgs> = {
    name: 'get_my_visit_context',
    description:
      "Read the signed-in engineer's current or assigned visit context, including its " +
      'authorized building passport. Use this before answering visit-specific questions. ' +
      'It does not report or cancel anything, and it does not expose physical stock counts.',
    schema: visitContextSchema,
    async run(ctx, args) {
      const engineerId = requireEngineerId(ctx);
      const view = await deps.live.engineerView(engineerId);
      const requestId = args.requestId ?? view.current?.request.id;
      const passport = requestId ? await deps.passports.engineerRead(engineerId, requestId) : null;
      return {
        ok: true,
        summary: requestId ? 'Authorized visit context read' : 'No current visit',
        resultContent: JSON.stringify({
          ...visitContext(view, passport),
          selectedRequestId: requestId ?? null,
          selectedRequestIsCurrent:
            requestId !== undefined && requestId === view.current?.request.id,
        }),
      };
    },
  };

  return [
    reportDelay,
    reportMissingEquipment,
    reportCannotComplete,
    reportEta,
    startTechnicalBreak,
    finishTechnicalBreak,
    changeStatusTo,
    getMyRoute,
    getMyVisitContext,
  ];
}
