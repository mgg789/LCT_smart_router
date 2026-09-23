import { useQuery } from '@tanstack/react-query';
import { getAssistedState } from '../api/getAssistedState';

export const assistedStateQueryKey = ['dispatch', 'assisted'] as const;

/** Automatic proposals can appear after a background replan, so this state is polled. */
export function useAssistedState() {
  return useQuery({
    queryKey: assistedStateQueryKey,
    queryFn: getAssistedState,
    refetchInterval: 5000,
  });
}
