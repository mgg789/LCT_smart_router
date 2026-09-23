import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getDispatchState } from '../api/getDispatchState';
import type { DispatchStateView } from './types';

export const planQueryKey = ['dispatch', 'plan'] as const;

/** There is no SSE, so the plan is polled (docs/frontend-api.md §6.5). */
export const PLAN_POLL_MS = 5_000;

export function useDispatchState() {
  return useQuery<DispatchStateView, ApiError>({
    queryKey: planQueryKey,
    queryFn: getDispatchState,
    refetchInterval: PLAN_POLL_MS,
  });
}
