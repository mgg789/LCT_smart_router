import { useQuery } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import { getPolicyComparison } from '../api/getPolicyComparison';
import type { PolicyComparison } from './comparison';

export const policyComparisonQueryKey = ['dispatch', 'policy-comparison'] as const;

/**
 * The comparison, fetched only when the dispatcher asks for it and then kept.
 *
 * It costs every policy a full search, so it never runs on mount or on a
 * timer; `refetch` is the «Сравнить» button. A stale result is not refreshed
 * behind the dispatcher's back either — the screen says it is stale instead.
 */
export function usePolicyComparison() {
  return useQuery<PolicyComparison, ApiError>({
    queryKey: policyComparisonQueryKey,
    queryFn: getPolicyComparison,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}
