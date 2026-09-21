import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getAlerts } from '../api/getAlerts';
import type { AlertsView } from './types';

export const alertsQueryKey = ['dispatch', 'alerts'] as const;

/** Poll interval for the day contour — the API has no SSE (docs/frontend-api.md §6.5). */
export const ALERTS_POLL_MS = 5_000;

export function useAlerts() {
  return useQuery<AlertsView, ApiError>({
    queryKey: alertsQueryKey,
    queryFn: getAlerts,
    refetchInterval: ALERTS_POLL_MS,
  });
}

/** Alerts still waiting for the dispatcher: what the bell badge counts. */
export function countUnseen(view: AlertsView | undefined): number {
  if (!view) return 0;
  return view.alerts.filter((alert) => alert.seenAt === null && alert.resolvedAt === null).length;
}
