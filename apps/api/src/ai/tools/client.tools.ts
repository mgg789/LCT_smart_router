import { z } from 'zod';
import { toRequestView } from '../../api/request-view';
import { AppConfigService } from '../../common/config';
import { RequestsService } from '../../orchestrator/requests/requests.service';
import type { PrismaService } from '../../persistence';
import { WORK_TYPE_CODES } from '../../orchestrator/requests/work-type.catalog';
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

  return [createRequest, listMyRequests];
}
