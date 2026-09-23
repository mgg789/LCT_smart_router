import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getDispatchLive } from '../api/getDispatchLive';
import type { DispatchLiveView } from './types';

export const liveQueryKey = ['dispatch', 'live'] as const;

/** Polled with the plan: there is no SSE (docs/frontend-api.md §6.5). */
export const LIVE_POLL_MS = 5_000;

export function useDispatchLive() {
  return useQuery<DispatchLiveView, ApiError>({
    queryKey: liveQueryKey,
    queryFn: getDispatchLive,
    refetchInterval: LIVE_POLL_MS,
  });
}
