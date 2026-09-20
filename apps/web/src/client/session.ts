/**
 * Device-local Client App session.
 *
 * Mirrors `engineer/session.ts` field-for-field: the server issues a session token with an
 * expiry, this store keeps it across reloads on the same device and drops it once
 * `expiresAt` has passed. Tampering with the stored expiry cannot extend the server
 * session -- every call still carries the bearer token, which the server independently
 * checks.
 */

export const CLIENT_SESSION_KEY = 'lct.client.session';

export interface StoredClientSession {
  readonly token: string;
  readonly expiresAt: number;
}

/** Reads a still-valid client session, or null when the device has none. */
export function readClientSession(
  storage: Storage,
  nowMs: number = Date.now(),
): StoredClientSession | null {
  const raw = storage.getItem(CLIENT_SESSION_KEY);
  if (raw === null) {
    return null;
  }
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
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    storage.removeItem(CLIENT_SESSION_KEY);
    return null;
  }
}

/** Persists the issued client session on this device. */
export function writeClientSession(storage: Storage, session: StoredClientSession): void {
  storage.setItem(CLIENT_SESSION_KEY, JSON.stringify(session));
}

/** Forgets the client session on this device. */
export function clearClientSession(storage: Storage): void {
  storage.removeItem(CLIENT_SESSION_KEY);
}
