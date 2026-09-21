import { useMutation } from '@tanstack/react-query';
import type { ApiError } from '@/shared/api';
import type { RequestLoginCodeInput, RequestLoginCodeResult } from '../api/requestLoginCode';
import { requestLoginCode } from '../api/requestLoginCode';

/**
 * Requesting a code is a plain command: it is not retried automatically, because a
 * retry sends the dispatcher a second letter.
 */
export function useRequestLoginCode() {
  return useMutation<RequestLoginCodeResult, ApiError, RequestLoginCodeInput>({
    mutationFn: requestLoginCode,
    retry: false,
  });
}
