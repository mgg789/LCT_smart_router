import type { ApiRequestOptions } from '@/shared/api';
import { apiRequest, isApiError } from '@/shared/api';
import { useSessionStore } from '../model/session.store';

/**
 * Calls a `dispatch/*` route with the current session token.
 *
 * A rejected token ends the session right here: leaving a dead token in the store
 * would keep every screen retrying against a door that is already closed, and the
 * router sends the dispatcher back to sign-in as soon as the session is gone.
 */
export async function authorizedRequest<T>(
  path: string,
  options: Omit<ApiRequestOptions, 'token'> = {},
): Promise<T> {
  const { session, signOut } = useSessionStore.getState();

  try {
    return await apiRequest<T>(path, { ...options, token: session?.token ?? null });
  } catch (error) {
    if (isApiError(error) && error.code === 'UNAUTHENTICATED') signOut();
    throw error;
  }
}
