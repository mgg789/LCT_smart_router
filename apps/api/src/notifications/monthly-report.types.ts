import { z } from 'zod';
import type { PerformanceAnalytics } from '../orchestrator/performance/types';

const engineerAnalyticsSchema = z.object({
  engineerId: z.string().nullable(),
  name: z.string().nullable(),
  recordedWorkdays: z.number().int(),
  completed: z.number().int(),
  completedPerRecordedWorkday: z.number().nullable(),
  measuredDuration: z.object({
    averageMinutes: z.number().nullable(),
    sampleCount: z.number().int(),
  }),
  punctualCompletion: z.object({
    count: z.number().int(),
    sampleCount: z.number().int(),
    rate: z.number().nullable(),
    averageLatenessMinutes: z.number().nullable(),
    baseline: z.literal('accepted_finish_at'),
  }),
  utilization: z.object({
    recordedWorkMinutes: z.number().int(),
    scheduledMinutes: z.number().int(),
    rate: z.number().nullable(),
    coverage: z.literal('partial_confirmed_execution'),
  }),
});

/** Validates durable snapshots before rendering or attaching them to mail. */
export const monthlyReportSchema = z.object({
  version: z.literal(1),
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  generatedAt: z.number().int(),
  provisional: z.boolean(),
  coverageStartAt: z.number().int().nullable(),
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
      categories: z.object({
        arrival: z.number(),
        completion: z.number(),
        passport: z.number(),
        penalty: z.number(),
      }),
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
  analytics: z
    .object({
      team: engineerAnalyticsSchema,
      engineers: z.array(engineerAnalyticsSchema),
      dailySeries: z.array(z.object({ workDate: z.string(), completed: z.number().int() })),
    })
    .optional(),
  notes: z.array(z.string()),
});

/** Frozen company-month facts; ratios are undefined when the team mean is non-positive. */
export interface MonthlyReportData {
  readonly version: 1;
  readonly month: string;
  readonly generatedAt: number;
  readonly provisional: boolean;
  readonly coverageStartAt: number | null;
  readonly totals: {
    readonly completed: number;
    readonly cancelled: number;
    readonly assumedCompleted: number;
    readonly workMinutes: number;
    readonly engineerCount: number;
    readonly earnedPoints: number;
    readonly penaltyPoints: number;
    readonly teamAverage: number | null;
  };
  readonly engineers: readonly {
    readonly engineerId: string;
    readonly name: string;
    readonly points: number;
    readonly earnedPoints: number;
    readonly penaltyPoints: number;
    readonly ratio: number | null;
    readonly completed: number;
    readonly workMinutes: number;
    readonly categories: {
      readonly arrival: number;
      readonly completion: number;
      readonly passport: number;
      readonly penalty: number;
    };
  }[];
  readonly days: readonly {
    readonly workDate: string;
    readonly score: number;
    readonly evaluated: boolean;
    readonly completed: number;
    readonly alertsResolved: number;
    readonly alertsTotal: number;
  }[];
  /** Absent on version-1 snapshots frozen before factual engineer analytics existed. */
  readonly analytics?: PerformanceAnalytics & {
    readonly dailySeries: readonly { readonly workDate: string; readonly completed: number }[];
  };
  readonly notes: readonly string[];
}
