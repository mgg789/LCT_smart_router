/**
 * Device-local Client App session.
 *
 * A successful email code creates the account and this token. The store keeps
 * it across reloads and drops it when `expiresAt` has passed. The server still
 * rejects a token that was revoked or invented.
 */

export const CLIENT_SESSION_KEY = 'lct.client.session';

export interface StoredClientSession {
  readonly token: string;
  readonly email: string;
  readonly expiresAt: number;
}

/** Reads a still-valid client session, or null when this device has none. */
export function readClientSession(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  nowMs: number = Date.now(),
): StoredClientSession | null {
  const raw = storage.getItem(CLIENT_SESSION_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredClientSession>;
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
      storage.removeItem(CLIENT_SESSION_KEY);
      return null;
    }
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt * 1000 <= nowMs) {
      storage.removeItem(CLIENT_SESSION_KEY);
      return null;
    }
    return {
      token: parsed.token,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      expiresAt: parsed.expiresAt,
    };
  } catch {
    storage.removeItem(CLIENT_SESSION_KEY);
    return null;
  }
}

/** Persists the issued client session on this device. */
export function writeClientSession(
  storage: Pick<Storage, 'setItem'>,
  session: StoredClientSession,
): void {
  storage.setItem(CLIENT_SESSION_KEY, JSON.stringify(session));
}

/** Forgets the client session on this device. The server session is separate. */
export function clearClientSession(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(CLIENT_SESSION_KEY);
}
