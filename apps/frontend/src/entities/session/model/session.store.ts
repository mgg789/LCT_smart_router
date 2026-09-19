import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Session } from './types';

const STORAGE_KEY = 'navix.dispatcher.session';

export interface SessionState {
  session: Session | null;
  signIn: (session: Session) => void;
  signOut: () => void;
}

/**
 * Dispatcher session.
 *
 * Stored in `sessionStorage`, not `localStorage`: the contract puts the dashboard
 * session in the tab (docs/frontend-api.md §2), and a shared dispatcher machine
 * must not keep a token after the tab is closed.
 */
export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      session: null,
      signIn: (session) => set({ session }),
      signOut: () => set({ session: null }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ session: state.session }),
    },
  ),
);

/** Unix seconds — the unit the API speaks. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isSessionAlive(session: Session | null): session is Session {
  return session !== null && session.expiresAt > nowSeconds();
}

/** Token for API calls, or `null` when there is no usable session. */
export function useSessionToken(): string | null {
  return useSessionStore((state) => (isSessionAlive(state.session) ? state.session.token : null));
}

export function useIsAuthenticated(): boolean {
  return useSessionStore((state) => isSessionAlive(state.session));
}
