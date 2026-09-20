import { z } from 'zod';

/** Returns whether a policy change reduced submitted-request coverage. */
export function policyCoverageRegressed(
  baselineSubmittedIds: readonly string[],
  newAssignedSubmittedIds: readonly string[],
): boolean {
  return newAssignedSubmittedIds.length < baselineSubmittedIds.length;
}

/** Accepts only Router's calculation-backed lunch coverage witness. */
export function lunchCoverageWitness(reasons: unknown): { lunch_start_at: number } | null {
  const schema = z.object({
    code: z.literal('LUNCH_COVERAGE_GAIN'),
    facts: z.object({
      additional_assigned_count: z.number().int().min(1),
      lunch_start_at: z.number().int(),
    }),
  });
  for (const reason of Array.isArray(reasons) ? reasons : [reasons]) {
    const parsed = schema.safeParse(reason);
    if (parsed.success) return parsed.data.facts;
  }
  return null;
}
