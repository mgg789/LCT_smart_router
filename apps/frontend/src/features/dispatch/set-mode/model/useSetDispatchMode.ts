import { useMutation, useQueryClient } from '@tanstack/react-query';
import { planQueryKey } from '@/entities/plan';
import type { ApiError } from '@/shared/api';
import type { SetDispatchModeInput, SetDispatchModeResult } from '../api/setDispatchMode';
import { setDispatchMode } from '../api/setDispatchMode';

/** Refreshes the authoritative control state after success or a version conflict. */
export function useSetDispatchMode() {
  const queryClient = useQueryClient();

  return useMutation<SetDispatchModeResult, ApiError, SetDispatchModeInput>({
    mutationFn: setDispatchMode,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
  });
}
