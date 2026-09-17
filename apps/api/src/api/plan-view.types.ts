import type {
  AppliedPlan,
  AppliedPlanAssignment,
  AppliedPlanRoute,
  AppliedPlanStop,
  RouterResult,
} from '../generated/prisma/client';

/** The shape `AppliedPlanService.current()` returns, named so views can depend on it. */
export type AppliedPlanCurrentShape = AppliedPlan & {
  routerResult: RouterResult | null;
  routes: Array<AppliedPlanRoute & { stops: AppliedPlanStop[] }>;
  assignments: AppliedPlanAssignment[];
};
