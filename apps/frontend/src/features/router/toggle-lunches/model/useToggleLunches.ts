import { useMutation, useQueryClient } from '@tanstack/react-query';
import { planQueryKey } from '@/entities/plan';
import { type RouterSettingsView, routerSettingsQueryKey } from '@/entities/router-settings';
import type { ApiError } from '@/shared/api';
import { setLunchesEnabled } from '../api/setLunchesEnabled';

/**
 * Turning lunches on changes what the Router is asked to solve, so the plan is
 * refetched along with the revision itself.
 */
export function useToggleLunches() {
  const queryClient = useQueryClient();

  return useMutation<RouterSettingsView, ApiError, boolean>({
    mutationFn: setLunchesEnabled,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: routerSettingsQueryKey });
      void queryClient.invalidateQueries({ queryKey: planQueryKey });
    },
  });
}
