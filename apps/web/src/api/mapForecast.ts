import { z } from 'zod';

/** Shared dispatcher/engineer decoder for read-only map forecasts. */
export const mapForecastSchema = z.object({
  observedAt: z.number().int().nullable(),
  state: z.enum(['fresh', 'mixed', 'stale', 'fallback']),
  warnings: z.array(z.string()),
});

/** Per-leg timestamp and source mode; a cached traffic response is never re-stamped as live. */
export const mapObservationSchema = z.object({
  observedAt: z.number().int(),
  expiresAt: z.number().int(),
  cacheState: z.enum(['live', 'cached', 'stale']),
  trafficMode: z.enum(['current', 'statistics', 'none']),
});
