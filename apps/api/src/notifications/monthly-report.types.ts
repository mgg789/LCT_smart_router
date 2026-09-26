import { z } from 'zod';

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
  readonly notes: readonly string[];
}
