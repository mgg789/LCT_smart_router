/** Session-scoped recovery data. Never stores credentials or queues server mutations. */
import { z } from 'zod';
import { DashboardApiError, parseDashboardSnapshot } from '../api/client';
import type { DashboardSnapshot } from '../api/types';

const CACHE_KEY = 'lct.saved-day.v1';
const SCOPE_KEY = 'lct.saved-day.scope';
const scopeSchema = z.object({ id: z.string(), expiresAt: z.number().int() });
const savedSchema = z.object({
  version: z.literal(1),
  scopeId: z.string(),
  savedAt: z.number().int(),
  snapshot: z.unknown(),
});

/** Enforce the known session expiry even while the backend is unreachable. */
export function recoverySessionExpired(storage: Storage, now = Date.now()): boolean {
  try {
    const scope = scopeSchema.safeParse(JSON.parse(storage.getItem(SCOPE_KEY) ?? 'null'));
    return scope.success && scope.data.expiresAt * 1000 <= now;
  } catch {
    return false;
  }
}

/** Small redacted diagnostic suitable for display/copying; no response bodies or tokens. */
export interface ConnectionDiagnostic {
  readonly at: number;
  readonly category: 'connection' | 'http' | 'contract' | 'storage';
  readonly status: number | null;
  readonly endpoint: string | null;
  readonly requestId: string | null;
}

/** Record metadata only; the original arbitrary server error text is not exported. */
export function connectionDiagnostic(cause: unknown): ConnectionDiagnostic {
  const error = cause instanceof DashboardApiError ? cause : null;
  return {
    at: Date.now(),
    category: error?.status
      ? 'http'
      : error?.message.includes('контракт')
        ? 'contract'
        : 'connection',
    status: error?.status ?? null,
    endpoint: error?.path.startsWith('/api/') ? (error.path.split('?')[0] ?? null) : null,
    requestId:
      error?.requestId && /^[a-zA-Z0-9_-]{1,80}$/.test(error.requestId) ? error.requestId : null,
  };
}

/** Start a new recovery namespace after successful login; expired sessions cannot restore it. */
export function startRecoverySession(storage: Storage, expiresAt: number): void {
  clearSavedDay(storage);
  try {
    storage.setItem(SCOPE_KEY, JSON.stringify({ id: crypto.randomUUID(), expiresAt }));
  } catch {
    /* Storage may be disabled. Live mode still works. */
  }
}

/** Remove both recovery data and its session binding on logout/auth failure. */
export function clearSavedDay(storage: Storage): void {
  try {
    storage.removeItem(CACHE_KEY);
    storage.removeItem(SCOPE_KEY);
  } catch {
    /* No durable cache in restricted storage. */
  }
}

/** Persist one validated complete view in this tab only. Returns false for unavailable storage. */
export function saveDay(storage: Storage, snapshot: DashboardSnapshot, now = Date.now()): boolean {
  try {
    const scope = scopeSchema.parse(JSON.parse(storage.getItem(SCOPE_KEY) ?? 'null'));
    if (scope.expiresAt * 1000 <= now) return false;
    const safe = parseDashboardSnapshot(snapshot);
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({
        version: 1,
        scopeId: scope.id,
        savedAt: now,
        snapshot: {
          ...safe,
          requests: safe.requests.map((request) => ({
            ...request,
            contactName: null,
            problemText: null,
          })),
        },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Read only a valid unexpired same-session view; corrupt or cross-session records are discarded. */
export function restoreDay(
  storage: Storage,
  hasToken: boolean,
  now = Date.now(),
): { snapshot: DashboardSnapshot; savedAt: number } | null {
  try {
    if (!hasToken) return null;
    const scope = scopeSchema.parse(JSON.parse(storage.getItem(SCOPE_KEY) ?? 'null'));
    const saved = savedSchema.parse(JSON.parse(storage.getItem(CACHE_KEY) ?? 'null'));
    if (
      scope.expiresAt * 1000 <= now ||
      saved.scopeId !== scope.id ||
      saved.savedAt > now ||
      saved.savedAt < 0
    ) {
      clearSavedDay(storage);
      return null;
    }
    return { snapshot: parseDashboardSnapshot(saved.snapshot), savedAt: saved.savedAt };
  } catch {
    clearSavedDay(storage);
    return null;
  }
}
