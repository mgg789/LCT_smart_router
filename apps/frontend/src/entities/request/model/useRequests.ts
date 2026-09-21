import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getRequests } from '../api/getRequests';
import type { RequestsView } from './types';

export const requestsQueryKey = ['dispatch', 'requests'] as const;

/** Polled with the plan — the API has no SSE (docs/frontend-api.md §6.5). */
export const REQUESTS_POLL_MS = 5_000;

export function useRequests() {
  return useQuery<RequestsView, ApiError>({
    queryKey: requestsQueryKey,
    queryFn: getRequests,
    refetchInterval: REQUESTS_POLL_MS,
  });
}
