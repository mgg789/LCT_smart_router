/**
 * Catalogue of dispatcher policies.
 *
 * The policy carries the whole hierarchy of goals; Engine holds no fixed business order of
 * its own (context/32 section 6.2). What the dispatcher picks here is a prepared variant:
 * the Dashboard is not an editor of formulas, weights or solver parameters, and this
 * catalogue is not a place to store executable input (context/33 section 5).
 *
 * A policy never switches off a hard constraint. Qualification, windows, shifts,
 * non-overlap, the ban on a second lunch and an established `lunch.required` are not
 * preferences that a policy can price away.
 */
export interface PolicySpec {
  readonly policyId: string;
  readonly title: string;
  readonly description: string;
  readonly isDefault: boolean;
  /** Only preferences this policy actually supports; `{}` is valid. */
  readonly parameters: Record<string, never>;
}

export const POLICIES: readonly PolicySpec[] = [
  {
    policyId: 'fast',
    title: 'Fast',
    description:
      'Starting preset: unassigned urgent work, then unassigned work overall, then ' +
      'skipped optional lunches, then total travel time, then distance, then the number ' +
      'of engineers with work. The resource block at the end is what distinguishes it ' +
      'from compact.',
    isDefault: true,
    parameters: {},
  },
  {
    policyId: 'compact',
    title: 'Compact',
    description:
      'Additional preset with the resource order staff, then distance, then time. ' +
      'Offered as an alternative, never as the default.',
    isDefault: false,
    parameters: {},
  },
] as const;

export const DEFAULT_POLICY_ID = 'fast';

export function findPolicy(policyId: string): PolicySpec | undefined {
  return POLICIES.find((policy) => policy.policyId === policyId);
}
