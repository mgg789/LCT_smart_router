import { z } from 'zod';
import { SysError } from '../../common/errors';
import type { PrismaService } from '../../persistence';
import type { ToolSpec } from './tool.types';

const verificationSchema = z.object({ operationId: z.string().min(1).max(128) }).strict();

/** Reads the actual post-action state of this account's operation in this conversation.
 * A recorded write, an alert's resolution and a fresh plan are separate facts; none is
 * reported as proof of a globally improved plan. No raw operation payload is returned.
 */
export function buildOperationVerificationTool(
  prisma: PrismaService,
): ToolSpec<z.infer<typeof verificationSchema>> {
  return {
    name: 'verify_operation_effect',
    description:
      'After a dispatcher write, verify its journal state, the original alert and related open alerts, and whether the applied plan matches the published planning input. Read-only. An applied operation alone does not prove the problem is fixed. Use only an operation_id returned in this conversation.',
    schema: verificationSchema,
    async run(ctx, args) {
      const result = await prisma.$transaction(
        async (tx) => {
          const operation = await tx.aiOperation.findFirst({
            where: {
              id: args.operationId,
              accountId: ctx.accountId,
              conversationId: ctx.conversationId,
            },
            select: { id: true, action: true, state: true, targetRef: true, completedAt: true },
          });
          if (!operation) throw SysError.notFound('AI operation');

          const originalAlert =
            operation.action === 'alert.resolve' && operation.targetRef
              ? await tx.alert.findUnique({
                  where: { id: operation.targetRef },
                  select: {
                    id: true,
                    code: true,
                    requestIds: true,
                    engineerIds: true,
                    resolvedAt: true,
                    invalidatedAt: true,
                  },
                })
              : null;
          const relatedScope = [
            ...(originalAlert?.requestIds.length
              ? [{ requestIds: { hasSome: originalAlert.requestIds } }]
              : []),
            ...(originalAlert?.engineerIds.length
              ? [{ engineerIds: { hasSome: originalAlert.engineerIds } }]
              : []),
            ...(operation.action.startsWith('request.') && operation.targetRef
              ? [{ requestIds: { has: operation.targetRef } }]
              : []),
          ];
          const relatedAlerts =
            relatedScope.length > 0
              ? await tx.alert.findMany({
                  where: { kind: 'alert', resolvedAt: null, invalidatedAt: null, OR: relatedScope },
                  select: {
                    id: true,
                    code: true,
                    severity: true,
                    requestIds: true,
                    engineerIds: true,
                  },
                  take: 21,
                })
              : null;
          const published = await tx.routingCurrent.findUnique({
            where: { id: 'singleton' },
            include: { snapshot: { select: { inputHash: true } } },
          });
          const applied = await tx.appliedPlanCurrent.findUnique({
            where: { id: 'singleton' },
            include: {
              plan: {
                select: {
                  revision: true,
                  origin: true,
                  appliedAt: true,
                  validatedInputHash: true,
                  routerResult: { select: { inputHash: true } },
                },
              },
            },
          });
          const appliedHash =
            applied?.plan.validatedInputHash ?? applied?.plan.routerResult?.inputHash ?? null;
          const publishedHash = published?.snapshot.inputHash ?? null;
          return {
            operationId: operation.id,
            action: operation.action,
            operationState: operation.state,
            operationApplied: operation.state === 'applied',
            completedAt: operation.completedAt === null ? null : Number(operation.completedAt),
            checkedAt: ctx.now,
            originalAlert: originalAlert
              ? {
                  id: originalAlert.id,
                  state:
                    originalAlert.invalidatedAt !== null
                      ? 'invalidated'
                      : originalAlert.resolvedAt !== null
                        ? 'resolved'
                        : 'open',
                }
              : null,
            relatedOpenAlerts: relatedAlerts?.slice(0, 20) ?? null,
            relatedAlertsTruncated: relatedAlerts !== null && relatedAlerts.length > 20,
            planning: {
              status:
                !publishedHash || !appliedHash
                  ? 'unverified'
                  : appliedHash === publishedHash
                    ? 'matches_published_input'
                    : 'awaiting_current_plan',
              appliedPlanRevision: applied?.plan.revision ?? null,
              publishedInputHash: publishedHash,
              appliedInputHash: appliedHash,
            },
            problemResolution: 'requires_assessment',
            limitations: [
              'A resolved or invalidated alert is a lifecycle fact, not proof of better route metrics.',
              'Matching planning input does not establish that all effects or all other alerts were checked.',
              ...(relatedAlerts === null
                ? ['No related-alert scope is available for this action.']
                : []),
            ],
          };
        },
        { isolationLevel: 'RepeatableRead' },
      );
      return {
        ok: true,
        summary: result.operationApplied
          ? 'Действие применено; состояние плана и связанных проблем проверено.'
          : 'Применение действия не подтверждено; проверьте его состояние.',
        resultContent: JSON.stringify(result),
      };
    },
  };
}
