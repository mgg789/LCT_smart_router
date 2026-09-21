import { useMutation, useQueryClient } from '@tanstack/react-query';
import { planQueryKey } from '@/entities/plan';
import type { PolicyId } from '@/entities/policy';
import { policiesQueryKey } from '@/entities/policy';
import type { ApiError } from '@/shared/api';
import type { SelectPolicyResult } from '../api/selectPolicy';
import { selectPolicy } from '../api/selectPolicy';

/**
 * Switching the policy republishes the task, so both the catalogue (whose
 * `active` moved) and the plan are refetched afterwards.
 */
export function useSelectPolicy() {
  const queryClient = useQueryClient();

  return useMutation<SelectPolicyResult, ApiError, PolicyId>({
    mutationFn: selectPolicy,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: policiesQueryKey });
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
  });
}
