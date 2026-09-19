import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSessionStore } from '@/entities/session';
import type { ApiError } from '@/shared/api';
import type { SignOutResult } from '../api/signOut';
import { signOut } from '../api/signOut';

/**
 * Signs out locally whatever the server answers.
 *
 * A failed call means the token is unusable or the API is unreachable; in both
 * cases keeping the session in the tab would only strand the dispatcher on a
 * screen that cannot load. The cache is cleared too, so the next session never
 * sees the previous dispatcher's day.
 */
export function useSignOut() {
  const clear = useSessionStore((state) => state.signOut);
  const queryClient = useQueryClient();

  return useMutation<SignOutResult, ApiError, void>({
    mutationFn: signOut,
    retry: false,
    onSettled: () => {
      clear();
      queryClient.clear();
    },
  });
}
