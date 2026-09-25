import { z } from 'zod';
import { requestJson } from './client';

const component = z.object({
  score: z.number(),
  weight: z.number(),
  evaluated: z.boolean(),
  explanation: z.string(),
});
/** Server-computed metrics distinguish confirmed results from silent schedule assumptions. */
export const performanceSchema = z.object({
  workdayId: z.string(),
  workDate: z.string(),
  closedAt: z.number().nullable(),
  engineerCount: z.number(),
  actual: z.object({ completed: z.number(), cancelled: z.number(), assumedCompleted: z.number() }),
  workMinutes: z.number(),
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
  if (!response.ok) throw new Error('Не удалось сформировать отчёт. Повторите загрузку.');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `navix-${month}.pdf`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
