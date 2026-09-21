/** Public plan fields needed to prove that a specific Router publication was applied. */
export interface SmokePlanResponse {
  readonly mode?: string;
  readonly plan?: {
    readonly revision: number;
    readonly origin: string;
    readonly planAsOf: number;
    readonly assignments: ReadonlyArray<{
      readonly requestId: string;
      readonly status: string;
      readonly engineerId: string | null;
    }>;
  } | null;
  readonly appliedResult?: { readonly resultId: string; readonly inputHash: string } | null;
  /** Diagnostics may refer to another package received within the same epoch second. */
  readonly lastResult?: {
    readonly resultId: string;
    readonly accepted: boolean;
    readonly rejectionCode: string | null;
  } | null;
}

/** Expected task identity and monotonic revisions for one asynchronous smoke step. */
export interface ExpectedSmokePlan {
  readonly requestIds: readonly string[];
  readonly engineerId: string;
  readonly inputHash: string;
  readonly minRevision?: number;
  readonly previousResultId?: string;
}

/**
 * Match the applied result relation, never the separately ordered last diagnostic.
 * The input hash binds the result to this publication; all requests must actually
 * be assigned to the expected engineer and optional revision/result bounds must advance.
 */
export function matchesSmokePlan(plan: SmokePlanResponse, expected: ExpectedSmokePlan): boolean {
  const applied = plan.appliedResult;
  if (
    plan.mode !== 'auto' ||
    plan.plan?.origin !== 'auto' ||
    !applied?.resultId ||
    applied.inputHash !== expected.inputHash ||
    (expected.previousResultId !== undefined && applied.resultId === expected.previousResultId) ||
    (expected.minRevision !== undefined && plan.plan.revision <= expected.minRevision)
  )
    return false;
  const byRequest = new Map(plan.plan.assignments.map((item) => [item.requestId, item]));
  return expected.requestIds.every((requestId) => {
    const assignment = byRequest.get(requestId);
    return assignment?.status === 'assigned' && assignment.engineerId === expected.engineerId;
  });
}
