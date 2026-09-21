/**
 * Device-local Engineer App session.
 *
 * The server issues a long-lived token. This store keeps that token across
 * reloads on the same device and drops it when `expiresAt` has passed.
 * Tampering with the stored expiry cannot extend the server session.
 */

export const ENGINEER_SESSION_KEY = 'lct.engineer.session';

export interface StoredEngineerSession {
  readonly token: string;
  readonly email: string;
  readonly expiresAt: number;
}

/** Reads a still-valid engineer session, or null when the device has none. */
export function readEngineerSession(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  nowMs: number = Date.now(),
): StoredEngineerSession | null {
  const raw = storage.getItem(ENGINEER_SESSION_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredEngineerSession>;
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) {
      storage.removeItem(ENGINEER_SESSION_KEY);
      return null;
    }
    if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt * 1000 <= nowMs) {
      storage.removeItem(ENGINEER_SESSION_KEY);
      return null;
    }
    return {
      token: parsed.token,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      expiresAt: parsed.expiresAt,
    };
  } catch {
    storage.removeItem(ENGINEER_SESSION_KEY);
    return null;
  }
}

/** Persists the issued engineer session on this device. */
export function writeEngineerSession(
  storage: Pick<Storage, 'setItem'>,
  session: StoredEngineerSession,
): void {
  storage.setItem(ENGINEER_SESSION_KEY, JSON.stringify(session));
}

/** Forgets the engineer session on this device. */
export function clearEngineerSession(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(ENGINEER_SESSION_KEY);
}
