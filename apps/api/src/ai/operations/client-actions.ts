import { z } from 'zod';
import { toRequestView } from '../../api/request-view';
import { SysError } from '../../common/errors';
import { formatUnixSeconds } from '../../common/time';
import type { AiActionCatalogDeps, AiActionSpec } from './ai-action.catalog';

const version = z.number().int().positive();
const cancelSchema = z.object({
  expectedVersion: version,
  reason: z.string().trim().max(2000).nullable(),
});
const rescheduleSchema = z
  .object({
    expectedVersion: version,
    windowStartAt: z.number().int().nonnegative(),
    windowEndAt: z.number().int().nonnegative(),
  })
  .refine((value) => value.windowEndAt > value.windowStartAt, 'Window end must follow start');

/** Client writes preserve ownership at preparation and transaction time, with version-bound confirmation. */
export function buildClientActions(
  deps: Pick<AiActionCatalogDeps, 'requests' | 'prisma' | 'timeZone'>,
): ReadonlyMap<string, AiActionSpec> {
  const owned = async (accountId: string, id: string | null) => {
    if (!id) throw SysError.validationFailed('A request is required');
    const row = await deps.prisma.request.findFirst({ where: { id, clientAccountId: accountId } });
    if (!row) throw SysError.notFound('Request');
    if (row.startedAt !== null || !['draft', 'submitted'].includes(row.lifecycle))
      throw SysError.validationFailed('Only a request that has not started can be changed');
    return row;
  };
  return new Map<string, AiActionSpec>([
    [
      'client.request.cancel',
      {
        zodSchema: cancelSchema,
        allowedProfiles: ['client'],
        async precheck(args) {
          await owned(args.accountId, args.targetRef);
        },
        async preview(args) {
          const row = await owned(args.accountId, args.targetRef);
          return [
            { label: 'Действие', value: 'Отменить заявку' },
            { label: 'Адрес', value: row.addressText },
          ];
        },
        async apply({ context, accountId, targetRef, payload }) {
          const input = cancelSchema.parse(payload);
          const row = await context.tx.request.findFirst({
            where: { id: targetRef ?? '', clientAccountId: accountId },
          });
          if (!row) throw SysError.notFound('Request');
          return toRequestView(
            await deps.requests.cancel(context, row.id, input.expectedVersion, input.reason),
          );
        },
      },
    ],
    [
      'client.request.reschedule',
      {
        zodSchema: rescheduleSchema,
        allowedProfiles: ['client'],
        async precheck(args) {
          await owned(args.accountId, args.targetRef);
        },
        async preview(args) {
          const row = await owned(args.accountId, args.targetRef);
          const input = rescheduleSchema.parse(args.payload);
          return [
            { label: 'Действие', value: 'Перенести заявку' },
            { label: 'Адрес', value: row.addressText },
            {
              label: 'Новое окно',
              value: `${formatUnixSeconds(input.windowStartAt, deps.timeZone)} — ${formatUnixSeconds(input.windowEndAt, deps.timeZone)}`,
            },
          ];
        },
        async apply({ context, accountId, targetRef, payload }) {
          const input = rescheduleSchema.parse(payload);
          const row = await context.tx.request.findFirst({
            where: { id: targetRef ?? '', clientAccountId: accountId },
          });
          if (!row) throw SysError.notFound('Request');
          return toRequestView(
            await deps.requests.reschedule(context, row.id, input.expectedVersion, input),
          );
        },
      },
    ],
  ]);
}
