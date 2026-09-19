import { authorizedRequest } from '@/entities/session';

export interface SignOutResult {
  signedOut: boolean;
}

/** `DELETE /auth/session` — idempotent (docs/frontend-api.md §2). */
export function signOut(): Promise<SignOutResult> {
  return authorizedRequest<SignOutResult>('/auth/session', { method: 'DELETE' });
}
