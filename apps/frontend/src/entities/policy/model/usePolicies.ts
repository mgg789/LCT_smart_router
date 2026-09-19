import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getPolicies } from '../api/getPolicies';
import type { PoliciesView } from './types';

export const policiesQueryKey = ['dispatch', 'policies'] as const;

/**
 * The catalogue changes only when the dispatcher picks another policy, so this
 * query is not polled — the mutation that switches policies invalidates it.
 */
export function usePolicies() {
  return useQuery<PoliciesView, ApiError>({
    queryKey: policiesQueryKey,
    queryFn: getPolicies,
    staleTime: 60_000,
  });
}
