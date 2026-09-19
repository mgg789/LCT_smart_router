import type { Session, SessionRole } from '@/entities/session';
import { apiRequest } from '@/shared/api';

export interface VerifyLoginCodeInput {
  email: string;
  /** Six digits as sent in the letter (docs/frontend-api.md §2). */
  code: string;
  role: SessionRole;
}

/** The API answers with exactly the fields of a session. */
export type VerifyLoginCodeResult = Session;

export function verifyLoginCode(input: VerifyLoginCodeInput): Promise<VerifyLoginCodeResult> {
  return apiRequest<VerifyLoginCodeResult>('/auth/login-code/verify', {
    method: 'POST',
    body: input,
  });
}
