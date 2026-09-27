import { z } from 'zod';
import { toRequestView } from '../../api/request-view';
import { AppConfigService } from '../../common/config';
import { SysError } from '../../common/errors';
import { RequestsService } from '../../orchestrator/requests/requests.service';
import { WORK_TYPE_CODES } from '../../orchestrator/requests/work-type.catalog';
import type { PrismaService } from '../../persistence';
import type { AiOperationService } from '../operations';
import { localDateSchema, localTimeSchema, localToUnixSeconds } from './local-time';
import type { ToolContext, ToolResult, ToolSpec } from './tool.types';

export interface ClientToolDeps {
  readonly aiOperations: AiOperationService;
  readonly requests: RequestsService;
  readonly prisma: PrismaService;
  readonly config: AppConfigService;
}

const equipmentSchema = z.enum(['router', 'set_top_box', 'smart_speaker']);

const createRequestSchema = z.object({
  contactName: z.string().trim().min(1).max(200),
  addressText: z.string().trim().min(1).max(500),
  workType: z.enum(WORK_TYPE_CODES as [string, ...string[]]),
  /** Local calendar day the visit window falls on, e.g. `2026-09-22`. */
  windowDate: localDateSchema,
  /** Local time the window opens, e.g. `09:00`. */
  windowStartLocal: localTimeSchema,
  /** Local time the window closes, e.g. `13:00`. */
  windowEndLocal: localTimeSchema,
  urgent: z.boolean(),
  requiredEquipment: equipmentSchema.optional(),
  problemText: z.string().trim().max(2_000).optional(),
});
export type CreateRequestArgs = z.infer<typeof createRequestSchema>;

const listMyRequestsSchema = z.object({});
export type ListMyRequestsArgs = z.infer<typeof listMyRequestsSchema>;

/**
 * The client catalogue: create a request and list the customer's own active ones.
 *
 * `create_request` never takes `lat`/`lon` -- without a point the request is honestly
 * stored as needing geocoding, exactly like the same field in `prepareRequestSchema`
 * (api/dto/request.dto.ts). `contactName`/`addressText`/`workType` are the only content
 * fields; the customer's account is always `ToolContext.accountId`, never an argument.
 */
export function buildClientTools(deps: ClientToolDeps): readonly ToolSpec[] {
  const createRequest: ToolSpec<CreateRequestArgs> = {
    name: 'create_request',
    description:
      'Prepare a new service request for the signed-in customer. This does not submit it ' +
      'yet -- a human must confirm the prepared card before it becomes a real request.',
    schema: createRequestSchema,
    async run(ctx: ToolContext, args: CreateRequestArgs): Promise<ToolResult> {
      const timeZone = deps.config.get('APP_TIME_ZONE');
      const windowStartAt = localToUnixSeconds(args.windowDate, args.windowStartLocal, timeZone);
      const windowEndAt = localToUnixSeconds(args.windowDate, args.windowEndLocal, timeZone);
      const prepared = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'request.create',
        targetRef: null,
        payload: {
          contactName: args.contactName,
          addressText: args.addressText,
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
      return {
        ok: true,
        summary: 'Prepared a new request, awaiting confirmation',
        resultContent: JSON.stringify({
          operation_id: prepared.operationId,
          state: prepared.state,
          preview: prepared.preview,
        }),
      };
    },
  };

  const listMyRequests: ToolSpec<ListMyRequestsArgs> = {
    name: 'list_my_requests',
    description: "List the signed-in customer's own active requests.",
    schema: listMyRequestsSchema,
    async run(ctx: ToolContext): Promise<ToolResult> {
      // Shared with `ClientController.list`'s own ownership rule: an account only ever
      // sees its own requests (`RequestsService.listActive`'s own doc comment).
      const requests = await deps.prisma.request.findMany({
        where: {
          clientAccountId: ctx.accountId,
          lifecycle: { notIn: ['completed', 'cancelled'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      const views = requests.map((request) => toRequestView(request));
      return {
        ok: true,
        summary: `${views.length} active request(s)`,
        resultContent: JSON.stringify({ requests: views }),
      };
    },
  };

  const ownRequest = async (ctx: ToolContext, requestId: string) => {
    const row = await deps.prisma.request.findFirst({
      where: { id: requestId, clientAccountId: ctx.accountId },
    });
    if (!row) throw SysError.notFound('Request');
    return row;
  };
  const getRequest: ToolSpec<{ requestId: string }> = {
    name: 'get_my_request',
    description:
      'Read the current status and fields of one request owned by the signed-in customer.',
    schema: z.object({ requestId: z.string().min(1) }),
    async run(ctx, args) {
      const request = await ownRequest(ctx, args.requestId);
      return {
        ok: true,
        summary: 'Current owned request',
        resultContent: JSON.stringify({ request: toRequestView(request) }),
      };
    },
  };
  const cancelRequest: ToolSpec<{ requestId: string; reason?: string }> = {
    name: 'cancel_my_request',
    description:
      'Prepare cancellation of an own request that has not started. The customer must confirm the card before cancellation.',
    schema: z.object({
      requestId: z.string().min(1),
      reason: z.string().trim().max(2000).optional(),
    }),
    async run(ctx, args) {
      const row = await ownRequest(ctx, args.requestId);
      const prepared = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'client.request.cancel',
        targetRef: row.id,
        payload: { expectedVersion: row.version, reason: args.reason ?? null },
      });
      return {
        ok: true,
        summary: 'Cancellation awaiting customer confirmation',
        resultContent: JSON.stringify({
          operation_id: prepared.operationId,
          state: prepared.state,
          preview: prepared.preview,
        }),
      };
    },
  };
  const rescheduleSchema = z.object({
    requestId: z.string().min(1),
    windowDate: localDateSchema,
    windowStartLocal: localTimeSchema,
    windowEndLocal: localTimeSchema,
  });
  const rescheduleRequest: ToolSpec<z.infer<typeof rescheduleSchema>> = {
    name: 'reschedule_my_request',
    description:
      'Prepare a new date/window for an own request that has not started. Never changes a request until the customer confirms the card.',
    schema: rescheduleSchema,
    async run(ctx, args) {
      const row = await ownRequest(ctx, args.requestId);
      const zone = deps.config.get('APP_TIME_ZONE');
      const prepared = await deps.aiOperations.prepare({
        actor: ctx.actor,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        action: 'client.request.reschedule',
        targetRef: row.id,
        payload: {
          expectedVersion: row.version,
          windowStartAt: localToUnixSeconds(args.windowDate, args.windowStartLocal, zone),
          windowEndAt: localToUnixSeconds(args.windowDate, args.windowEndLocal, zone),
        },
      });
      return {
        ok: true,
        summary: 'Window change awaiting customer confirmation',
        resultContent: JSON.stringify({
          operation_id: prepared.operationId,
          state: prepared.state,
          preview: prepared.preview,
        }),
      };
    },
  };
  return [createRequest, listMyRequests, getRequest, cancelRequest, rescheduleRequest];
}
