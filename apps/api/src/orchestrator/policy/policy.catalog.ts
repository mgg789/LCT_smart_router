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
      'Common order first: urgent coverage, total coverage, optional lunches and total ' +
      'lateness; then travel time, distance and engineers used.',
    isDefault: false,
    parameters: {},
  },
  {
    policyId: 'compact',
    title: 'Compact',
    description:
      'Common coverage and lateness order first; then use fewer engineers, shorter distance ' +
      'and less travel time.',
    isDefault: true,
    parameters: {},
  },
  {
    policyId: 'sla',
    title: 'SLA safe',
    description:
      'After common urgent and total coverage, maximize minimum start slack against the ' +
      'original customer window, then reduce travel.',
    isDefault: false,
    parameters: {},
  },
  {
    policyId: 'balanced',
    title: 'Balanced',
    description:
      'After common urgent and total coverage, minimize the maximum utilized shift fraction, ' +
      'then minimize workload spread in seconds.',
    isDefault: false,
    parameters: {},
  },
  {
    policyId: 'eco',
    title: 'Eco',
    description:
      'Common coverage and lateness order first; then minimize distance, engineers used and ' +
      'travel time.',
    isDefault: false,
    parameters: {},
  },
  {
    policyId: 'covering',
    title: 'Covering',
    description:
      'Increase feasible coverage with demand-matched regional crews and route reassignment; ' +
      'reduce the additional workforce without claiming a proven minimum or impossible windows.',
    isDefault: false,
    parameters: {},
  },
] as const;

export const DEFAULT_POLICY_ID = 'compact';

export function findPolicy(policyId: string): PolicySpec | undefined {
  return POLICIES.find((policy) => policy.policyId === policyId);
}
