import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DispatchMode } from '@/entities/plan';
import { planQueryKey } from '@/entities/plan';
import type { ApiError } from '@/shared/api';
import type { SetDispatchModeResult } from '../api/setDispatchMode';
import { setDispatchMode } from '../api/setDispatchMode';

export function useSetDispatchMode() {
  const queryClient = useQueryClient();

  return useMutation<SetDispatchModeResult, ApiError, DispatchMode>({
    mutationFn: setDispatchMode,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
  });
}
