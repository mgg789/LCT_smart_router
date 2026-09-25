import { z } from 'zod';
import { toDayView } from '../../api/engineer-view';
import { toRequestView } from '../../api/request-view';
import type { Actor } from '../../auth';
import { SysError } from '../../common/errors';
import { formatUnixSeconds } from '../../common/time';
import type { AiRoleProfile, Request } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import {
  type AlertAction,
  AlertsService,
  alertActionsFor,
  type ResolveAlertInput,
} from '../../orchestrator/alerts';
import {
  EngineersService,
  type WorkdayInput,
} from '../../orchestrator/engineers/engineers.service';
import { assertLunchConditions } from '../../orchestrator/engineers/workday';
import { LiveService } from '../../orchestrator/live/live.service';
import { findPolicy, PolicyService } from '../../orchestrator/policy';
import { RequestsService } from '../../orchestrator/requests/requests.service';
// Catalog file only, not the `requests` barrel: the barrel also loads Nest modules and
// can leave `findWorkType` undefined under CJS circular imports in unit tests
// (mirrors api/request-view.ts's own note on this).
import { findWorkType, WORK_TYPE_CODES } from '../../orchestrator/requests/work-type.catalog';
import { PrismaService } from '../../persistence';
import { PUBLICATION_TRIGGERS, SnapshotPublisher } from '../../routing/mount-data-eng';
import type { AiPreviewRow } from '../runtime/ai-event.types';

/**
 * The AI-gateway's own catalogue of writable actions.
 *
 * Deliberately not a second implementation of any business rule: every `apply` below
 * calls the exact orchestrator method the matching HTTP controller calls
 * (`ClientController`, `EngineerController`), through the exact same `OperationsService`
 * a human's click reaches, so there is exactly one vocabulary of writable actions
 * (context/36 section 2), not one per entry point.
 *
 * `zodSchema` here validates the *operation payload* `AiOperationService.prepare` stores,
 * not the arguments a model supplies -- a tool computes a subject like `requestId` or
 * `engineerId` from the trusted session and folds it into this payload before calling
 * `prepare`, so it never has to appear in a `ToolSpec.schema` a model sees (tool.types.ts).
 */

/** Read-only context for `precheck` and `preview`: no transaction, only what the actor
 *  and the stored operation already establish. */
export interface AiActionCheckArgs<TPayload> {
  readonly actor: Actor;
  readonly accountId: string;
  readonly targetRef: string | null;
  readonly payload: TPayload;
  readonly now: number;
}

/** What `apply` gets: the same read-only facts plus the transaction and business clock
 *  `OperationsService.execute` opened for this write. */
export interface AiActionApplyArgs<TPayload> extends AiActionCheckArgs<TPayload> {
  readonly context: OperationContext;
}

export interface AiActionSpec<TPayload = unknown> {
  readonly zodSchema: z.ZodType<TPayload>;
  /** Role profiles allowed to prepare or confirm this action. Re-checked at confirm time
   *  against the actor's *current* profile, so a dispatcher's `fix -> help` flip made
   *  after a card was prepared blocks the write regardless of what was true when the
   *  model received the catalogue (ai-operation.service.ts's own note on this). */
  readonly allowedProfiles: readonly AiRoleProfile[];
  /** Cheap existence/lifecycle/capability check run before a card is ever shown, so a
   *  button is not offered for something certain to fail. Throws `SysError` to refuse. */
  readonly precheck: (args: AiActionCheckArgs<TPayload>) => Promise<void>;
  /** Server-rendered preview rows for the confirmation card. Never the model's prose. */
  readonly preview: (args: AiActionCheckArgs<TPayload>) => Promise<readonly AiPreviewRow[]>;
  readonly apply: (args: AiActionApplyArgs<TPayload>) => Promise<unknown>;
}

export interface AiActionCatalogDeps {
  readonly requests: RequestsService;
  readonly live: LiveService;
  readonly engineers: EngineersService;
  readonly alerts: AlertsService;
  readonly policy: PolicyService;
  readonly publisher: SnapshotPublisher;
  /** Read-only lookups a precheck needs (the alert row, the request row) that have no
   *  dedicated service method of their own -- the same pattern `engineer.tools.ts`'s
   *  prechecks already use through a service, applied here directly since the alert
   *  and request rows themselves have none. */
  readonly prisma: PrismaService;
  readonly timeZone: string;
}

const requestIdSchema = z.string().min(1);
const noteSchema = z.string().trim().min(1).max(2_000);
const equipmentTypeSchema = z.enum(['router', 'set_top_box', 'smart_speaker']);
const unixSecondsSchema = z.number().int().nonnegative();
const latitudeSchema = z.number().min(-90).max(90);
const longitudeSchema = z.number().min(-180).max(180);

export const createRequestPayloadSchema = z.object({
  /**
   * The client this request belongs to. Absent when the `client` profile prepares its
   * own request (the subject is always `ToolContext.accountId` there, tool.types.ts's
   * own rule); present when `dispatcher_fix` prepares one on a customer's behalf, where
   * it names the customer by address the same way `DispatchController.create` does --
   * the object of the action, never the dispatcher's own subject, which is why this
   * field does not violate the no-subject-argument invariant (test/unit/ai-tools.test.ts).
   */
  clientEmail: z.email().optional(),
  contactName: z.string().min(1).max(200),
  addressText: z.string().min(1).max(500),
  lat: latitudeSchema.nullish(),
  lon: longitudeSchema.nullish(),
  workType: z.enum(WORK_TYPE_CODES as [string, ...string[]]),
  requiredEquipment: equipmentTypeSchema.nullish(),
  windowStartAt: unixSecondsSchema,
  windowEndAt: unixSecondsSchema,
  urgent: z.boolean(),
  problemText: z.string().max(2_000).nullish(),
});
export type CreateRequestPayload = z.infer<typeof createRequestPayloadSchema>;

export const updateRequestPayloadSchema = z.object({
  expectedVersion: z.number().int().positive().nullish(),
  windowStartAt: unixSecondsSchema.optional(),
  windowEndAt: unixSecondsSchema.optional(),
  addressText: z.string().min(1).max(500).optional(),
  lat: latitudeSchema.nullish(),
  lon: longitudeSchema.nullish(),
  urgent: z.boolean().optional(),
  requiredEquipment: equipmentTypeSchema.nullish(),
});
export type UpdateRequestPayload = z.infer<typeof updateRequestPayloadSchema>;

export const cancelRequestPayloadSchema = z.object({
  expectedVersion: z.number().int().positive().nullish(),
  reason: z.string().trim().max(2_000).nullish(),
});
export type CancelRequestPayload = z.infer<typeof cancelRequestPayloadSchema>;

export const selectPolicyPayloadSchema = z.object({ policyId: z.string().min(1).max(64) });
export type SelectPolicyPayload = z.infer<typeof selectPolicyPayloadSchema>;

const alertActionSchema = z.enum([
  'reschedule',
  'move_window',
  'add_engineer',
  'keep_manual',
  // The alert endpoint accepts this one too (orchestrator/alerts/alert-policy.ts),
  // and `time_risk` offers nothing else — without it the assistant cannot propose
  // the only decision that alert has.
  'keep_as_is',
  'restore_auto',
  'skip_lunch',
  'keep_lunch',
  'message',
  'remove_shift',
  'message_remove',
  'extend',
]);

export const resolveAlertPayloadSchema = z.object({
  action: alertActionSchema,
  reason: z.string().trim().min(1).max(2_000).optional(),
  minutes: z.number().int().min(1).max(240).optional(),
  windowStartAt: unixSecondsSchema.optional(),
  windowEndAt: unixSecondsSchema.optional(),
  /** Names the engineer object of `add_engineer`, never the acting dispatcher. */
  engineerId: z.string().min(1).optional(),
});
export type ResolveAlertPayload = z.infer<typeof resolveAlertPayloadSchema>;

export const markAlertSeenPayloadSchema = z.object({});

export const closeShiftPayloadSchema = z.object({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type CloseShiftPayload = z.infer<typeof closeShiftPayloadSchema>;

export const dispatcherSetAvailabilityPayloadSchema = z.object({
  availability: z.enum(['online', 'offline']),
});
export type DispatcherSetAvailabilityPayload = z.infer<
  typeof dispatcherSetAvailabilityPayloadSchema
>;

export const setWorkdayPayloadSchema = z.object({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shiftStartAt: unixSecondsSchema,
  shiftEndAt: unixSecondsSchema,
  lunch: z
    .object({
      enabled: z.boolean(),
      durationSec: z.number().int().positive().nullish(),
      windowStartAt: unixSecondsSchema.nullish(),
      windowEndAt: unixSecondsSchema.nullish(),
    })
    .optional(),
  lunchRequired: z.boolean().optional(),
  attendanceOptOut: z.boolean().optional(),
});
export type SetWorkdayPayload = z.infer<typeof setWorkdayPayloadSchema>;

export const liveNoArgsPayloadSchema = z.object({});

export const liveEtaPayloadSchema = z.object({
  requestId: requestIdSchema,
  etaAt: unixSecondsSchema,
});
export type LiveEtaPayload = z.infer<typeof liveEtaPayloadSchema>;

export const liveProblemPayloadSchema = z.object({
  requestId: requestIdSchema,
  problemKind: z.enum(['delay', 'missing_equipment', 'other', 'impossible']),
  note: noteSchema,
  additionalDurationSec: z.number().int().positive().max(86_400).optional(),
  missingEquipment: equipmentTypeSchema.optional(),
});
export type LiveProblemPayload = z.infer<typeof liveProblemPayloadSchema>;

export const liveOfflinePayloadSchema = z.object({ note: noteSchema });
export type LiveOfflinePayload = z.infer<typeof liveOfflinePayloadSchema>;

export const setAvailabilityPayloadSchema = z.object({
  availability: z.enum(['online', 'offline']),
});
export type SetAvailabilityPayload = z.infer<typeof setAvailabilityPayloadSchema>;

function requireEngineerId(targetRef: string | null): string {
  if (!targetRef) {
    throw new SysError('VALIDATION_FAILED', 'This action needs the engineer as its target');
  }
  return targetRef;
}

/** Every dispatcher action below addresses one object (a request, an alert, a work
 *  date) by `targetRef`; a tool that reaches `prepare` without one is a caller bug. */
function requireTargetRef(targetRef: string | null, what: string): string {
  if (!targetRef) {
    throw new SysError('VALIDATION_FAILED', `This action needs ${what} as its target`);
  }
  return targetRef;
}

/** Mirrors `RequestsService`'s own private `assertChangeable`: started, finished or
 *  cancelled work is closed to ordinary condition changes regardless of entry path
 *  (context/42 DF-05). Duplicated here only as an early, friendly precheck -- the
 *  authoritative check stays inside `RequestsService` itself. */
function assertRequestChangeable(request: Request): void {
  if (request.lifecycle === 'in_progress' || request.startedAt !== null) {
    throw new SysError('WORK_ALREADY_STARTED', 'The engineer has already started this work', {
      details: { requestId: request.id },
    });
  }
  if (request.lifecycle === 'completed') {
    throw new SysError('WORK_ALREADY_STARTED', 'This work is already finished', {
      details: { requestId: request.id },
    });
  }
  if (request.lifecycle === 'cancelled') {
    throw new SysError('VALIDATION_FAILED', 'This request is cancelled', {
      details: { requestId: request.id },
    });
  }
}

/** The account a dispatcher-created request belongs to, upserted by address exactly the
 *  way `DispatchController.create` does -- the AI path shares that method rather than
 *  re-implementing it, so a `clientEmail` argument always resolves the same account a
 *  human dispatcher's own request form would. */
async function ensureClientAccount(
  context: OperationContext,
  clientEmail: string,
): Promise<string> {
  const email = clientEmail.trim().toLowerCase();
  const account = await context.tx.account.upsert({
    where: { email },
    update: {},
    create: { email, createdAt: BigInt(context.now), updatedAt: BigInt(context.now) },
  });
  await context.tx.accountRole.upsert({
    where: { accountId_role: { accountId: account.id, role: 'client' } },
    update: {},
    create: { accountId: account.id, role: 'client', grantedAt: BigInt(context.now) },
  });
  return account.id;
}

export function buildAiActionCatalog(deps: AiActionCatalogDeps): ReadonlyMap<string, AiActionSpec> {
  const catalog = new Map<string, AiActionSpec>();

  catalog.set('request.create', {
    zodSchema: createRequestPayloadSchema,
    // `dispatcher_fix` added alongside `client`: the same payload shape serves both, and
    // `clientEmail`'s presence (never its absence) is what tells `apply` below which
    // account owns the new request -- see the field's own doc comment.
    allowedProfiles: ['client', 'dispatcher_fix'],
    async precheck(args) {
      const payload = args.payload as CreateRequestPayload;
      if (payload.windowEndAt < payload.windowStartAt) {
        throw new SysError('VALIDATION_FAILED', 'The window ends before it starts');
      }
      if (!findWorkType(payload.workType)) {
        throw new SysError('VALIDATION_FAILED', 'Unknown type of work', {
          details: { workType: payload.workType },
        });
      }
    },
    async preview(args) {
      const payload = args.payload as CreateRequestPayload;
      const spec = findWorkType(payload.workType);
      return [
        ...(payload.clientEmail ? [{ label: 'Клиент', value: payload.clientEmail }] : []),
        { label: 'Контактное лицо', value: payload.contactName },
        { label: 'Адрес', value: payload.addressText },
        { label: 'Тип работ', value: spec?.title ?? payload.workType },
        {
          label: 'Окно',
          value: `${formatUnixSeconds(payload.windowStartAt, deps.timeZone)} – ${formatUnixSeconds(payload.windowEndAt, deps.timeZone)}`,
        },
        { label: 'Срочно', value: payload.urgent ? 'да' : 'нет' },
      ];
    },
    async apply({ context, accountId, payload }) {
      const input = payload as CreateRequestPayload;
      // A dispatcher names the customer by address (`DispatchController.create`'s own
      // upsert); a customer's own session always uses its own account. `clientEmail`
      // is the object of this write, never a stand-in for the acting subject.
      const ownerAccountId = input.clientEmail
        ? await ensureClientAccount(context, input.clientEmail)
        : accountId;
      const prepared = await deps.requests.prepare(context, ownerAccountId, {
        contactName: input.contactName,
        addressText: input.addressText,
        lat: input.lat ?? null,
        lon: input.lon ?? null,
        workType: input.workType,
        ...(input.requiredEquipment === undefined
          ? {}
          : { requiredEquipment: input.requiredEquipment }),
        windowStartAt: input.windowStartAt,
        windowEndAt: input.windowEndAt,
        urgent: input.urgent,
        problemText: input.problemText ?? null,
      });
      // A request the assistant creates on the customer's behalf is already a task: there
      // is no separate screen for the customer to confirm content they just dictated,
      // mirroring `DispatchController.create`'s own prepare-then-submit in one operation.
      // View-converted like every controller handler: `OperationsService.execute` stores
      // this return value as JSON, and a raw Prisma row carries BigInt fields no JSON
      // encoder accepts.
      return toRequestView(await deps.requests.submit(context, prepared.id, prepared.version));
    },
  });

  catalog.set('request.update', {
    zodSchema: updateRequestPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck(args) {
      const requestId = requireTargetRef(args.targetRef, 'a request');
      const payload = args.payload as UpdateRequestPayload;
      if (
        payload.windowStartAt !== undefined &&
        payload.windowEndAt !== undefined &&
        payload.windowEndAt < payload.windowStartAt
      ) {
        throw new SysError('VALIDATION_FAILED', 'The window ends before it starts');
      }
      const request = await deps.prisma.request.findUnique({ where: { id: requestId } });
      if (!request) throw SysError.notFound('Request', { requestId });
      assertRequestChangeable(request);
    },
    async preview(args) {
      const payload = args.payload as UpdateRequestPayload;
      const rows: AiPreviewRow[] = [];
      if (payload.windowStartAt !== undefined && payload.windowEndAt !== undefined) {
        rows.push({
          label: 'Новое окно',
          value: `${formatUnixSeconds(payload.windowStartAt, deps.timeZone)} – ${formatUnixSeconds(payload.windowEndAt, deps.timeZone)}`,
        });
      }
      if (payload.addressText !== undefined) {
        rows.push({ label: 'Адрес', value: payload.addressText });
      }
      if (payload.urgent !== undefined) {
        rows.push({ label: 'Срочно', value: payload.urgent ? 'да' : 'нет' });
      }
      if (payload.requiredEquipment !== undefined) {
        rows.push({ label: 'Оборудование', value: payload.requiredEquipment ?? 'не требуется' });
      }
      return rows;
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as UpdateRequestPayload;
      return toRequestView(
        await deps.requests.updateConditions(
          context,
          requireTargetRef(targetRef, 'a request'),
          input.expectedVersion ?? null,
          {
            ...(input.windowStartAt === undefined ? {} : { windowStartAt: input.windowStartAt }),
            ...(input.windowEndAt === undefined ? {} : { windowEndAt: input.windowEndAt }),
            ...(input.addressText === undefined ? {} : { addressText: input.addressText }),
            ...(input.lat === undefined ? {} : { lat: input.lat }),
            ...(input.lon === undefined ? {} : { lon: input.lon }),
            ...(input.urgent === undefined ? {} : { urgent: input.urgent }),
            ...(input.requiredEquipment === undefined
              ? {}
              : { requiredEquipment: input.requiredEquipment }),
          },
        ),
      );
    },
  });

  catalog.set('request.cancel', {
    zodSchema: cancelRequestPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck(args) {
      const requestId = requireTargetRef(args.targetRef, 'a request');
      const request = await deps.prisma.request.findUnique({ where: { id: requestId } });
      if (!request) throw SysError.notFound('Request', { requestId });
      if (request.lifecycle !== 'cancelled') {
        assertRequestChangeable(request);
      }
    },
    async preview(args) {
      const payload = args.payload as CancelRequestPayload;
      return [
        { label: 'Действие', value: 'Отменить заявку' },
        ...(payload.reason ? [{ label: 'Причина', value: payload.reason }] : []),
      ];
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as CancelRequestPayload;
      return toRequestView(
        await deps.requests.cancel(
          context,
          requireTargetRef(targetRef, 'a request'),
          input.expectedVersion ?? null,
          input.reason ?? null,
        ),
      );
    },
  });

  catalog.set('policy.select', {
    zodSchema: selectPolicyPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck(args) {
      const payload = args.payload as SelectPolicyPayload;
      if (!findPolicy(payload.policyId)) {
        throw new SysError('VALIDATION_FAILED', 'Unknown policy', {
          details: { policyId: payload.policyId },
        });
      }
    },
    async preview(args) {
      const payload = args.payload as SelectPolicyPayload;
      const spec = findPolicy(payload.policyId);
      return [{ label: 'Политика', value: spec?.title ?? payload.policyId }];
    },
    async apply({ context, payload }) {
      const input = payload as SelectPolicyPayload;
      const selected = await deps.policy.select(context, input.policyId);
      // The choice is data of the task, so it is republished, exactly like
      // `DispatchController.selectPolicy`'s own call.
      const publication = await deps.publisher.publishIfChanged(
        context.tx,
        context.now,
        PUBLICATION_TRIGGERS.POLICY_CHANGED,
      );
      return { ...selected, publication };
    },
  });

  // The dispatcher's own availability control, distinct from the shared
  // `engineer.set_availability` entry above: that entry mirrors the engineer's
  // self-service endpoint (`EngineerController.setAvailability`), which is legacy-gated
  // and refuses outright while a LIVE workday is running. The dispatcher's real HTTP
  // endpoint (`DispatchController.setEngineerAvailability`) has no such gate -- it always
  // goes through `LiveService.setDispatcherAvailability`, which itself knows how to
  // update a running LIVE day's engineer state as well as the legacy day row. Reusing the
  // engineer-only entry here would silently narrow a dispatcher capability the human
  // dashboard actually has, so this is a separate catalogue key instead.
  catalog.set('dispatcher.engineer.set_availability', {
    zodSchema: dispatcherSetAvailabilityPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck() {},
    async preview(args) {
      const payload = args.payload as DispatcherSetAvailabilityPayload;
      return [
        {
          label: 'Действие',
          value: payload.availability === 'online' ? 'Вывести на линию' : 'Снять с линии',
        },
      ];
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as DispatcherSetAvailabilityPayload;
      return toDayView(
        await deps.live.setDispatcherAvailability(
          context,
          requireEngineerId(targetRef),
          input.availability,
          null,
        ),
      );
    },
  });

  catalog.set('engineer.set_workday', {
    zodSchema: setWorkdayPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck(args) {
      const payload = args.payload as SetWorkdayPayload;
      if (payload.shiftEndAt <= payload.shiftStartAt) {
        throw new SysError('VALIDATION_FAILED', 'A shift must have a positive duration');
      }
      assertLunchConditions(payload.lunch ?? { enabled: false }, payload.lunchRequired ?? false);
    },
    async preview(args) {
      const payload = args.payload as SetWorkdayPayload;
      const rows: AiPreviewRow[] = [
        { label: 'Дата', value: payload.workDate },
        {
          label: 'Смена',
          value: `${formatUnixSeconds(payload.shiftStartAt, deps.timeZone)} – ${formatUnixSeconds(payload.shiftEndAt, deps.timeZone)}`,
        },
      ];
      if (payload.lunch?.enabled) {
        rows.push({ label: 'Обед', value: 'включён' });
      }
      return rows;
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as SetWorkdayPayload;
      const workdayInput: WorkdayInput = {
        workDate: input.workDate,
        shiftStartAt: input.shiftStartAt,
        shiftEndAt: input.shiftEndAt,
        ...(input.lunch === undefined ? {} : { lunch: input.lunch }),
        ...(input.lunchRequired === undefined ? {} : { lunchRequired: input.lunchRequired }),
        ...(input.attendanceOptOut === undefined
          ? {}
          : { attendanceOptOut: input.attendanceOptOut }),
      };
      return toDayView(
        await deps.engineers.setWorkday(context, requireEngineerId(targetRef), workdayInput),
      );
    },
  });

  catalog.set('engineer.technical_break', {
    zodSchema: liveNoArgsPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck() {
      // Matches `DispatchController.startEngineerTechnicalBreak`'s own gate: the
      // dispatcher-initiated 15-minute stop is a legacy (pre-LIVE) action.
      await deps.live.assertLegacyMutationAllowed();
    },
    async preview() {
      return [{ label: 'Действие', value: 'Технический перерыв (15 минут)' }];
    },
    async apply({ context, targetRef }) {
      return toDayView(
        await deps.engineers.startTechnicalBreak(context, requireEngineerId(targetRef)),
      );
    },
  });

  catalog.set('alert.resolve', {
    zodSchema: resolveAlertPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck(args) {
      const alertId = requireTargetRef(args.targetRef, 'an alert');
      const payload = args.payload as ResolveAlertPayload;
      const alert = await deps.prisma.alert.findUnique({ where: { id: alertId } });
      if (!alert) {
        throw SysError.notFound('Alert', { alertId });
      }
      if (alert.kind !== 'alert') {
        throw new SysError('VALIDATION_FAILED', 'A notice has no resolution action');
      }
      if (alert.resolvedAt !== null || alert.invalidatedAt !== null) {
        throw new SysError('VALIDATION_FAILED', 'This alert is already resolved');
      }
      // The finite dispatcher action catalogue for this alert code is the guarantee: a
      // model may never talk the system into an action `alertActionsFor` does not list
      // for this exact code, and this precheck refuses it before a card is ever shown
      // rather than coercing it into a nearby allowed action.
      const allowed = alertActionsFor(alert.code) as readonly AlertAction[];
      if (!allowed.includes(payload.action)) {
        throw new SysError('VALIDATION_FAILED', 'This action is not available for the alert', {
          details: { code: alert.code, action: payload.action, actions: allowed },
        });
      }
      if (payload.action === 'add_engineer' && !payload.engineerId) {
        throw new SysError('VALIDATION_FAILED', 'Adding an engineer needs engineerId');
      }
      if (payload.action === 'keep_manual' && !payload.reason) {
        throw new SysError('VALIDATION_FAILED', 'Keeping a degraded plan requires a reason');
      }
    },
    async preview(args) {
      const payload = args.payload as ResolveAlertPayload;
      const rows: AiPreviewRow[] = [{ label: 'Решение', value: payload.action }];
      if (payload.engineerId) {
        rows.push({ label: 'Инженер', value: payload.engineerId });
      }
      if (payload.windowStartAt !== undefined && payload.windowEndAt !== undefined) {
        rows.push({
          label: 'Новое окно',
          value: `${formatUnixSeconds(payload.windowStartAt, deps.timeZone)} – ${formatUnixSeconds(payload.windowEndAt, deps.timeZone)}`,
        });
      }
      if (payload.minutes !== undefined) {
        rows.push({ label: 'Минут', value: String(payload.minutes) });
      }
      if (payload.reason) {
        rows.push({ label: 'Причина', value: payload.reason });
      }
      return rows;
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as ResolveAlertPayload;
      const resolveInput: ResolveAlertInput = {
        action: input.action,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.minutes === undefined ? {} : { minutes: input.minutes }),
        ...(input.windowStartAt === undefined ? {} : { windowStartAt: input.windowStartAt }),
        ...(input.windowEndAt === undefined ? {} : { windowEndAt: input.windowEndAt }),
        ...(input.engineerId === undefined ? {} : { engineerId: input.engineerId }),
      };
      return deps.alerts.resolve(context, requireTargetRef(targetRef, 'an alert'), resolveInput);
    },
  });

  catalog.set('alert.mark_seen', {
    zodSchema: markAlertSeenPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck(args) {
      const alertId = requireTargetRef(args.targetRef, 'an alert');
      const alert = await deps.prisma.alert.findUnique({ where: { id: alertId } });
      if (!alert) {
        throw SysError.notFound('Alert', { alertId });
      }
    },
    async preview() {
      return [{ label: 'Действие', value: 'Отметить как просмотренное' }];
    },
    async apply({ context, targetRef }) {
      const alertId = requireTargetRef(targetRef, 'an alert');
      await deps.alerts.markSeen(alertId, context.now);
      return { seen: true, alertId };
    },
  });

  catalog.set('shift.close', {
    zodSchema: closeShiftPayloadSchema,
    allowedProfiles: ['dispatcher_fix'],
    async precheck(args) {
      const payload = args.payload as CloseShiftPayload;
      const status = await deps.alerts.shiftStatus(payload.workDate);
      if (status.unresolvedCount > 0) {
        throw new SysError('SHIFT_CLOSE_BLOCKED', 'Resolve every alert before closing this shift', {
          details: { workDate: payload.workDate, unresolvedCount: status.unresolvedCount },
        });
      }
    },
    async preview(args) {
      const payload = args.payload as CloseShiftPayload;
      return [{ label: 'Закрыть смену', value: payload.workDate }];
    },
    async apply({ context, payload }) {
      const input = payload as CloseShiftPayload;
      return deps.alerts.closeShift(context, input.workDate);
    },
  });

  catalog.set('live.engineer.online', {
    zodSchema: liveNoArgsPayloadSchema,
    allowedProfiles: ['engineer'],
    async precheck() {},
    async preview() {
      return [{ label: 'Действие', value: 'Выйти на линию' }];
    },
    async apply({ context, targetRef }) {
      return deps.live.act(context, requireEngineerId(targetRef), {
        operationId: context.operationId,
        kind: 'online',
      });
    },
  });

  catalog.set('live.engineer.break_start', {
    zodSchema: liveNoArgsPayloadSchema,
    allowedProfiles: ['engineer'],
    async precheck(args) {
      const engineerId = requireEngineerId(args.targetRef);
      const view = await deps.live.engineerView(engineerId);
      if (view.current?.phase === 'in_progress') {
        throw new SysError(
          'VALIDATION_FAILED',
          'Finish or report the active visit before a technical break',
        );
      }
    },
    async preview() {
      return [{ label: 'Действие', value: 'Начать технический перерыв' }];
    },
    async apply({ context, targetRef }) {
      return deps.live.act(context, requireEngineerId(targetRef), {
        operationId: context.operationId,
        kind: 'break_start',
      });
    },
  });

  catalog.set('live.engineer.break_finish', {
    zodSchema: liveNoArgsPayloadSchema,
    allowedProfiles: ['engineer'],
    async precheck() {},
    async preview() {
      return [{ label: 'Действие', value: 'Завершить технический перерыв' }];
    },
    async apply({ context, targetRef }) {
      return deps.live.act(context, requireEngineerId(targetRef), {
        operationId: context.operationId,
        kind: 'break_finish',
      });
    },
  });

  // There is no `on_time` action any more: the engineer reports an arrival time
  // instead (docs/live.md, «Удалён `on_time`»), which `live.engineer.eta` below
  // prepares. A tool for an action the API refuses could only fail at confirm.
  catalog.set('live.engineer.eta', {
    zodSchema: liveEtaPayloadSchema,
    allowedProfiles: ['engineer'],
    async precheck(args) {
      const engineerId = requireEngineerId(args.targetRef);
      const payload = args.payload as LiveEtaPayload;
      const view = await deps.live.engineerView(engineerId);
      if (view.current?.request.id !== payload.requestId) {
        throw new SysError('VALIDATION_FAILED', 'This is not the nearest current visit');
      }
    },
    async preview(args) {
      const payload = args.payload as LiveEtaPayload;
      return [
        { label: 'Действие', value: 'Сообщить прогноз прибытия' },
        { label: 'Заявка', value: payload.requestId },
        { label: 'Прогноз', value: formatUnixSeconds(payload.etaAt, deps.timeZone) },
      ];
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as LiveEtaPayload;
      return deps.live.act(context, requireEngineerId(targetRef), {
        operationId: context.operationId,
        kind: 'eta',
        requestId: input.requestId,
        etaAt: input.etaAt,
      });
    },
  });

  catalog.set('live.engineer.problem', {
    zodSchema: liveProblemPayloadSchema,
    allowedProfiles: ['engineer'],
    async precheck(args) {
      const engineerId = requireEngineerId(args.targetRef);
      const payload = args.payload as LiveProblemPayload;
      const view = await deps.live.engineerView(engineerId);
      if (view.current?.request.id !== payload.requestId) {
        throw new SysError('VALIDATION_FAILED', 'This is not the nearest current visit');
      }
      // The tool-level guarantee for a delay report: the model never invents the extra
      // minutes into a moment nothing is in progress at.
      if (payload.problemKind === 'delay' && view.current?.phase !== 'in_progress') {
        throw new SysError(
          'VALIDATION_FAILED',
          'Report additional time only while the visit is in progress',
        );
      }
      if (payload.problemKind === 'delay' && payload.additionalDurationSec === undefined) {
        throw new SysError('VALIDATION_FAILED', 'A delay needs an additional duration');
      }
      if (payload.problemKind === 'missing_equipment' && payload.missingEquipment === undefined) {
        throw new SysError('VALIDATION_FAILED', 'Choose the missing equipment');
      }
    },
    async preview(args) {
      const payload = args.payload as LiveProblemPayload;
      const rows: AiPreviewRow[] = [
        { label: 'Действие', value: problemLabel(payload.problemKind) },
        { label: 'Заявка', value: payload.requestId },
      ];
      if (payload.additionalDurationSec !== undefined) {
        rows.push({
          label: 'Доп. время',
          value: `${Math.round(payload.additionalDurationSec / 60)} мин`,
        });
      }
      if (payload.missingEquipment !== undefined) {
        rows.push({ label: 'Оборудование', value: payload.missingEquipment });
      }
      rows.push({ label: 'Комментарий', value: payload.note });
      return rows;
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as LiveProblemPayload;
      return deps.live.act(context, requireEngineerId(targetRef), {
        operationId: context.operationId,
        kind: 'problem',
        requestId: input.requestId,
        problemKind: input.problemKind,
        note: input.note,
        ...(input.additionalDurationSec === undefined
          ? {}
          : { additionalDurationSec: input.additionalDurationSec }),
        ...(input.missingEquipment === undefined
          ? {}
          : { missingEquipment: input.missingEquipment }),
      });
    },
  });

  // The engineer's own mid-day stand-down. Deliberately not the same key as
  // `engineer.set_availability`/`dispatcher.engineer.set_availability`: neither of those
  // can run while a LIVE workday is running (the former is legacy-gated, the latter is
  // dispatcher-only), and this one carries a required reason `LiveService.goOffline`
  // needs nothing else to act on but a check card should still show.
  catalog.set('live.engineer.offline', {
    zodSchema: liveOfflinePayloadSchema,
    allowedProfiles: ['engineer'],
    async precheck(args) {
      const engineerId = requireEngineerId(args.targetRef);
      const view = await deps.live.engineerView(engineerId);
      if (view.engineer.lineStatus === 'technical_break') {
        throw new SysError(
          'VALIDATION_FAILED',
          'The engineer must finish the technical break explicitly',
        );
      }
      if (view.current?.phase === 'in_progress') {
        throw new SysError(
          'WORK_ALREADY_STARTED',
          'Finish or report the active visit before going offline',
        );
      }
    },
    async preview(args) {
      const payload = args.payload as LiveOfflinePayload;
      return [
        { label: 'Действие', value: 'Снятие с линии' },
        { label: 'Причина', value: payload.note },
      ];
    },
    async apply() {
      throw new SysError(
        'VALIDATION_FAILED',
        'Going offline from the assistant is not part of this contour',
      );
    },
  });

  // Shared with `EngineerController.setAvailability`'s own action (the self-service
  // endpoint, legacy-gated the same way): only the actor differs. This is *not* the same
  // write `DispatchController.setEngineerAvailability` makes -- that endpoint goes
  // through `LiveService.setDispatcherAvailability`, which also knows how to update a
  // running LIVE day. The dispatcher's own preparer therefore uses the dedicated
  // `dispatcher.engineer.set_availability` entry below rather than this one, so an AI
  // fix-mode capability never falls short of what the human dashboard can already do.
  catalog.set('engineer.set_availability', {
    zodSchema: setAvailabilityPayloadSchema,
    allowedProfiles: ['engineer', 'dispatcher_fix'],
    async precheck() {
      await deps.live.assertLegacyMutationAllowed();
    },
    async preview(args) {
      const payload = args.payload as SetAvailabilityPayload;
      return [
        {
          label: 'Действие',
          value: payload.availability === 'online' ? 'Выйти на линию' : 'Уйти офлайн',
        },
      ];
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as SetAvailabilityPayload;
      // View-converted for the same reason as `request.create`'s apply above.
      return toDayView(
        await deps.engineers.setAvailability(
          context,
          requireEngineerId(targetRef),
          input.availability,
          null,
        ),
      );
    },
  });

  return catalog;
}

function problemLabel(kind: LiveProblemPayload['problemKind']): string {
  switch (kind) {
    case 'delay':
      return 'Сообщить о задержке';
    case 'missing_equipment':
      return 'Сообщить о нехватке оборудования';
    case 'impossible':
      return 'Заявку невозможно выполнить';
    case 'other':
      return 'Заявку выполнить не удаётся';
    default: {
      const exhaustive: never = kind;
      return String(exhaustive);
    }
  }
}
