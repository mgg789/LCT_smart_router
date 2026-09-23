import { useMutation, useQueryClient } from '@tanstack/react-query';
import { liveQueryKey } from '@/entities/live';
import { planQueryKey } from '@/entities/plan';
import { requestsQueryKey } from '@/entities/request';
import type { ApiError } from '@/shared/api';
import { startWorkday } from '../api/startWorkday';

/** Refreshes the day and first plan after the dispatcher starts the shift. */
export function useStartWorkday() {
  const queryClient = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof startWorkday>>, ApiError>({
    mutationFn: startWorkday,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: liveQueryKey });
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
      void queryClient.invalidateQueries({ queryKey: requestsQueryKey });
    },
  });
}
