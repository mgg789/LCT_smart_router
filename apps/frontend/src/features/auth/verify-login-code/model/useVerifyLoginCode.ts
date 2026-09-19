import { useMutation } from '@tanstack/react-query';
import { useSessionStore } from '@/entities/session';
import type { ApiError } from '@/shared/api';
import type { VerifyLoginCodeInput, VerifyLoginCodeResult } from '../api/verifyLoginCode';
import { verifyLoginCode } from '../api/verifyLoginCode';

/**
 * Verifying the code is the moment the session appears, so the store is written
 * here rather than in the page: any caller of this feature gets the same effect.
 */
export function useVerifyLoginCode() {
  const signIn = useSessionStore((state) => state.signIn);

  return useMutation<VerifyLoginCodeResult, ApiError, VerifyLoginCodeInput>({
    mutationFn: verifyLoginCode,
    retry: false,
    onSuccess: (session) => signIn(session),
  });
}
