import { SysError } from '../../common/errors';
import type { Tx } from '../../persistence';

/** Resolve exact IDs or unique visible UUID prefixes; never guess between matching requests. */
export async function resolveRequestReference(tx: Tx, reference: string) {
  const id = reference.trim();
  const exact = await tx.request.findUnique({ where: { id } });
  if (exact) return exact;
  if (!/^[a-f0-9]{8,}(?:-[a-f0-9-]*)?$/i.test(id))
    throw SysError.notFound('Request', { requestId: id });
  const matches = await tx.request.findMany({
    where: { id: { startsWith: id.toLowerCase() } },
    take: 2,
  });
  if (matches.length > 1)
    throw new SysError(
      'VALIDATION_FAILED',
      'Короткий номер неоднозначен. Укажите полный ID заявки.',
      { details: { kind: 'ambiguous_request_reference', requestReference: id } },
    );
  if (!matches[0]) throw SysError.notFound('Request', { requestId: id });
  return matches[0];
}
