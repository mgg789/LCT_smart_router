import { apiRequest } from '@/shared/api';

export interface RequestLoginCodeInput {
  email: string;
}

export interface RequestLoginCodeResult {
  email: string;
  /** Unix seconds until which the emailed code stays valid. */
  expiresAt: number;
  /**
   * Present only when the API runs with `AUTH_DEV_EXPOSE_CODES=true`. Never rely
   * on it: with SMTP configured the code exists only in the letter.
   */
  devCode?: string;
}

/**
 * Asks the System Layer to email a login code.
 *
 * The answer is identical for a known and an unknown address — the API does not
 * disclose whether an account exists, and neither does the UI.
 */
export function requestLoginCode(input: RequestLoginCodeInput): Promise<RequestLoginCodeResult> {
  return apiRequest<RequestLoginCodeResult>('/auth/login-code', {
    method: 'POST',
    body: input,
  });
}
