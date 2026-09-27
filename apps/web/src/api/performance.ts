import { z } from 'zod';
import { t } from '../i18n';
import { requestJson } from './client';

const component = z.object({
  score: z.number(),
  weight: z.number(),
  evaluated: z.boolean(),
  explanation: z.string(),
});
/** Only explicit execution samples contribute; missing measurements stay null. */
export const engineerAnalyticsSchema = z.object({
  recordedWorkdays: z.number(),
  completed: z.number(),
  completedPerRecordedWorkday: z.number().nullable(),
  measuredDuration: z.object({ averageMinutes: z.number().nullable(), sampleCount: z.number() }),
  punctualCompletion: z.object({
    count: z.number(),
    sampleCount: z.number(),
    rate: z.number().nullable(),
    averageLatenessMinutes: z.number().nullable(),
    baseline: z.literal('accepted_finish_at'),
  }),
  utilization: z.object({
    recordedWorkMinutes: z.number(),
    scheduledMinutes: z.number(),
    rate: z.number().nullable(),
    coverage: z.literal('partial_confirmed_execution'),
  }),
});
const analyticsSchema = z.object({
  team: engineerAnalyticsSchema,
  engineers: z.array(
    engineerAnalyticsSchema.extend({ engineerId: z.string(), name: z.string().nullable() }),
  ),
  dailySeries: z.array(z.object({ workDate: z.string(), completed: z.number() })).optional(),
});
const engineerMetricSchema = z.object({
  engineerId: z.string(),
  completed: z.number(),
  cancelled: z.number(),
  assumedCompleted: z.number(),
  workMinutes: z.number(),
});
export type EngineerAnalytics = z.infer<typeof engineerAnalyticsSchema>;
/** Server-computed metrics distinguish confirmed results from silent schedule assumptions. */
export const performanceSchema = z.object({
  workdayId: z.string(),
  workDate: z.string(),
  closedAt: z.number().nullable(),
  engineerCount: z.number(),
  actual: z.object({ completed: z.number(), cancelled: z.number(), assumedCompleted: z.number() }),
  workMinutes: z.number(),
  engineers: z.array(engineerMetricSchema).optional(),
  analytics: analyticsSchema.optional(),
  nextDay: z
    .object({
      workDate: z.string(),
      openRequestCount: z.number(),
      overdueOpenCount: z.number(),
      requests: z.array(
        z.object({
          requestId: z.string(),
          arrivalOrder: z.number(),
          addressText: z.string(),
          windowStartAt: z.number(),
          windowEndAt: z.number(),
          priority: z.string(),
        }),
      ),
    })
    .nullable()
    .optional(),
  alerts: z.object({ significantTotal: z.number(), resolved: z.number(), unresolved: z.number() }),
  policy: z.object({
    selectedPolicyId: z.string().nullable(),
    measured: z.boolean(),
    score: z.number(),
    explanation: z.string(),
  }),
  score: z.object({
    score: z.number().min(0).max(100),
    evaluated: z.boolean(),
    alertProcessing: component,
    policyChoice: component,
    explanation: z.array(z.string()),
  }),
});
export type DayPerformance = z.infer<typeof performanceSchema>;

/** Frozen legacy monthly reports remain valid without the new analytics section. */
export const monthlyPerformanceSchema = z.object({
  version: z.literal(1),
  month: z.string(),
  generatedAt: z.number(),
  provisional: z.boolean(),
  coverageStartAt: z.number().nullable(),
  totals: z.object({
    completed: z.number(),
    cancelled: z.number(),
    assumedCompleted: z.number(),
    workMinutes: z.number(),
    engineerCount: z.number(),
    earnedPoints: z.number(),
    penaltyPoints: z.number(),
    teamAverage: z.number().nullable(),
  }),
  engineers: z.array(
    z.object({
      engineerId: z.string(),
      name: z.string(),
      points: z.number(),
      earnedPoints: z.number(),
      penaltyPoints: z.number(),
      ratio: z.number().nullable(),
      completed: z.number(),
      workMinutes: z.number(),
    }),
  ),
  days: z.array(
    z.object({
      workDate: z.string(),
      score: z.number(),
      evaluated: z.boolean(),
      completed: z.number(),
      alertsResolved: z.number(),
      alertsTotal: z.number(),
    }),
  ),
  notes: z.array(z.string()),
  analytics: analyticsSchema.optional(),
});
export type MonthlyPerformance = z.infer<typeof monthlyPerformanceSchema>;
const personalPerformanceSchema = z.object({
  workdayId: z.string(),
  workDate: z.string(),
  closedAt: z.number().nullable(),
  engineer: engineerMetricSchema.nullable(),
  analytics: engineerAnalyticsSchema.nullable().optional(),
});
export type PersonalPerformance = z.infer<typeof personalPerformanceSchema>;

/** Reads monthly charts and the PDF from the same authorized report snapshot. */
export function loadMonthlyPerformance(token: string, month: string) {
  return requestJson(
    `/api/v1/dispatch/reports/monthly/${encodeURIComponent(month)}/data`,
    monthlyPerformanceSchema,
    token,
  );
}

/** Server authorization limits this response to the signed-in engineer. */
export function loadPersonalPerformance(token: string, workdayId: string) {
  return requestJson(
    `/api/v1/engineer/performance/day?workdayId=${encodeURIComponent(workdayId)}`,
    personalPerformanceSchema,
    token,
  );
}

/** Dispatcher performance is loaded for an explicit durable workday id. */
export function loadDayPerformance(token: string, workdayId: string) {
  return requestJson(
    `/api/v1/dispatch/performance/day?workdayId=${encodeURIComponent(workdayId)}`,
    performanceSchema,
    token,
  );
}

/** Automatic UI completion must wait for both execution and dispatcher decisions. */
export function shouldShowDayResults(
  status: string | undefined,
  unresolved: number | undefined,
  closedAt: number | null | undefined,
): boolean {
  return status === 'finished' && unresolved === 0 && closedAt === null;
}

/** Downloads the authorized PDF without exposing the session token in a URL. */
export async function downloadMonthlyReport(token: string, month: string): Promise<void> {
  const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
  const response = await fetch(
    `${base}/api/v1/dispatch/reports/monthly/${encodeURIComponent(month)}`,
    {
      headers: { authorization: `Bearer ${token}`, accept: 'application/pdf' },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(t('api.performance.874ba15bf7'));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `navix-${month}.pdf`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
