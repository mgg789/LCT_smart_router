import { useMutation, useQueryClient } from '@tanstack/react-query';
import { planQueryKey } from '@/entities/plan';
import { requestsQueryKey } from '@/entities/request';
import type { ApiError } from '@/shared/api';
import type { ReassignRequestInput } from '../api/reassignRequest';
import { reassignRequest } from '../api/reassignRequest';

/** Moving work changes both the plan and the request, so both are refetched. */
export function useReassignRequest() {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, ReassignRequestInput>({
    mutationFn: reassignRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
      void queryClient.invalidateQueries({ queryKey: requestsQueryKey });
    },
  });
}
