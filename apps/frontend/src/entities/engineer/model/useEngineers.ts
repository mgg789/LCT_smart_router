import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getEngineers } from '../api/getEngineers';
import type { EngineersView } from './types';

export const engineersQueryKey = ['dispatch', 'engineers'] as const;

/** Crews change less often than the plan, so this polls at a calmer pace. */
export const ENGINEERS_POLL_MS = 15_000;

export function useEngineers() {
  return useQuery<EngineersView, ApiError>({
    queryKey: engineersQueryKey,
    queryFn: getEngineers,
    refetchInterval: ENGINEERS_POLL_MS,
  });
}
