import { useMutation } from '@tanstack/react-query';
import { useSessionStore } from '@/entities/session';
import type { ApiError } from '@/shared/api';
import type { VerifyLoginCodeInput, VerifyLoginCodeResult } from '../api/verifyLoginCode';
import { verifyLoginCode } from '../api/verifyLoginCode';

/**
 * Verifying the code is the moment the session appears, so the store is written
 * here rather than in the page: any caller of this feature gets the same effect.
 *
 * The address comes from the request, not the answer — the API does not echo it,
 * and the UI needs it to name the signed-in dispatcher.
 */
export function useVerifyLoginCode() {
  const signIn = useSessionStore((state) => state.signIn);

  return useMutation<VerifyLoginCodeResult, ApiError, VerifyLoginCodeInput>({
    mutationFn: verifyLoginCode,
    retry: false,
    onSuccess: (result, variables) => signIn({ ...result, email: variables.email }),
  });
}
