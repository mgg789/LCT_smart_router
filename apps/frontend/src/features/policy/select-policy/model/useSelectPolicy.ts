import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DispatchStateView } from '@/entities/plan';
import { planQueryKey } from '@/entities/plan';
import type { PolicyId } from '@/entities/policy';
import { policiesQueryKey, policyTitle } from '@/entities/policy';
import type { ApiError } from '@/shared/api';
import type { SelectPolicyResult } from '../api/selectPolicy';
import { selectPolicy } from '../api/selectPolicy';
import { beginRecalculation } from './recalculation';

/**
 * Switching the policy republishes the task, so both the catalogue (whose
 * `active` moved) and the plan are refetched afterwards, and the
 * «Пересчёт маршрутов» notice stays up until the new plan arrives.
 */
export function useSelectPolicy() {
  const queryClient = useQueryClient();

  return useMutation<SelectPolicyResult, ApiError, PolicyId>({
    mutationFn: selectPolicy,
    onSuccess: (_result, policyId) => {
      const current = queryClient.getQueryData<DispatchStateView>(planQueryKey);
      beginRecalculation(current?.plan?.revision ?? null, policyTitle(policyId));
      void queryClient.invalidateQueries({ queryKey: policiesQueryKey });
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
  });
}
