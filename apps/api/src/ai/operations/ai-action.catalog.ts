import { z } from 'zod';
import { toDayView } from '../../api/engineer-view';
import { toRequestView } from '../../api/request-view';
import type { Actor } from '../../auth';
import { SysError } from '../../common/errors';
import { formatUnixSeconds } from '../../common/time';
import type { AiRoleProfile } from '../../generated/prisma/client';
import type { OperationContext } from '../../operations';
import { EngineersService } from '../../orchestrator/engineers/engineers.service';
import { LiveService } from '../../orchestrator/live/live.service';
import { RequestsService } from '../../orchestrator/requests/requests.service';
// Catalog file only, not the `requests` barrel: the barrel also loads Nest modules and
// can leave `findWorkType` undefined under CJS circular imports in unit tests
// (mirrors api/request-view.ts's own note on this).
import { findWorkType, WORK_TYPE_CODES } from '../../orchestrator/requests/work-type.catalog';
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
  readonly timeZone: string;
}

const requestIdSchema = z.string().min(1);
const noteSchema = z.string().trim().min(1).max(2_000);
const equipmentTypeSchema = z.enum(['router', 'set_top_box', 'smart_speaker']);
const unixSecondsSchema = z.number().int().nonnegative();

export const createRequestPayloadSchema = z.object({
  contactName: z.string().min(1).max(200),
  addressText: z.string().min(1).max(500),
  workType: z.enum(WORK_TYPE_CODES as [string, ...string[]]),
  requiredEquipment: equipmentTypeSchema.nullish(),
  windowStartAt: unixSecondsSchema,
  windowEndAt: unixSecondsSchema,
  urgent: z.boolean(),
  problemText: z.string().max(2_000).nullish(),
});
export type CreateRequestPayload = z.infer<typeof createRequestPayloadSchema>;

export const liveNoArgsPayloadSchema = z.object({});

export const liveOnTimePayloadSchema = z.object({ requestId: requestIdSchema });
export type LiveOnTimePayload = z.infer<typeof liveOnTimePayloadSchema>;

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

export function buildAiActionCatalog(deps: AiActionCatalogDeps): ReadonlyMap<string, AiActionSpec> {
  const catalog = new Map<string, AiActionSpec>();

  catalog.set('request.create', {
    zodSchema: createRequestPayloadSchema,
    allowedProfiles: ['client'],
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
      const prepared = await deps.requests.prepare(context, accountId, {
        contactName: input.contactName,
        addressText: input.addressText,
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
      if (view.current !== null) {
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

  catalog.set('live.engineer.on_time', {
    zodSchema: liveOnTimePayloadSchema,
    allowedProfiles: ['engineer'],
    async precheck(args) {
      const engineerId = requireEngineerId(args.targetRef);
      const payload = args.payload as LiveOnTimePayload;
      const view = await deps.live.engineerView(engineerId);
      if (view.current?.request.id !== payload.requestId) {
        throw new SysError('VALIDATION_FAILED', 'This is not the nearest current visit');
      }
    },
    async preview(args) {
      const payload = args.payload as LiveOnTimePayload;
      return [
        { label: 'Действие', value: 'Подтвердить прибытие вовремя' },
        { label: 'Заявка', value: payload.requestId },
      ];
    },
    async apply({ context, targetRef, payload }) {
      const input = payload as LiveOnTimePayload;
      return deps.live.act(context, requireEngineerId(targetRef), {
        operationId: context.operationId,
        kind: 'on_time',
        requestId: input.requestId,
      });
    },
  });

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

  // Shared with `DispatchController`'s own `engineer.set_availability` action: the write
  // is the same `EngineersService.setAvailability` either way, only the actor differs.
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
