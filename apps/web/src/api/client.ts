import { createDevSnapshot } from '../fixtures/dev-day';
import type { DashboardSnapshot } from './types';

/**
 * Dashboard data source.
 *
 * Dev contour reads a typed fixture that matches `GET /api/v1/dispatch/plan`,
 * `GET /api/v1/dispatch/engineers`, `GET /api/v1/dispatch/requests` and
 * `GET /api/v1/dispatch/alerts`. When `VITE_API_BASE` is set the same types
 * are the integration surface — no screen rewrite.
 */
export function loadDashboardSnapshot(): DashboardSnapshot {
  return createDevSnapshot();
}
