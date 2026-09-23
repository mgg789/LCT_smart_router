import { useMutation, useQueryClient } from '@tanstack/react-query';
import { planQueryKey } from '@/entities/plan';
import type { ApiError } from '@/shared/api';
import type { ReorderRequestInput } from '../api/reorderRequest';
import { reorderRequest } from '../api/reorderRequest';

/** Reloads the authoritative plan after a saved order or a version conflict. */
export function useReorderRequest() {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiError, ReorderRequestInput>({
    mutationFn: reorderRequest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
  });
}
