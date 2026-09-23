import { useMutation, useQueryClient } from '@tanstack/react-query';
import { alertsQueryKey } from '@/entities/alert';
import type { ApiError } from '@/shared/api';
import { markAlertSeen } from '../api/markAlertSeen';

/** Hides a notice (or marks an alert read) and refetches the list it came from. */
export function useMarkAlertSeen() {
  const queryClient = useQueryClient();

  return useMutation<{ seen: true }, ApiError, string>({
    mutationFn: markAlertSeen,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: alertsQueryKey });
    },
  });
}
