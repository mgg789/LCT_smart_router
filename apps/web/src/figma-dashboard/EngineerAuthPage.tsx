import { useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { signOutEngineer } from '../api/engineer';
import type { EngineerAuthSession } from '../api/types';
import { isEngineerDesignPreview } from '../figma-engineer/designPreview';
import { EngineerApp } from '../figma-engineer/EngineerApp';
import { EngineerLogin } from '../figma-engineer/EngineerLogin';
import {
  clearEngineerSession,
  readEngineerSession,
  writeEngineerSession,
} from '../figma-engineer/session';
import { AuthToastLayer } from './AuthToastLayer';

/**
 * Engineer sign-in at `/engineer`. A live session opens the Figma day list.
 */
export function EngineerAuthPage() {
  const motionOn = !useReducedMotion();
  const [session, setSession] = useState(() => readEngineerSession(window.localStorage));

  const accept = (next: EngineerAuthSession, email: string) => {
    const stored = { token: next.token, email, expiresAt: next.expiresAt };
    writeEngineerSession(window.localStorage, stored);
    setSession(stored);
  };

  const forget = () => {
    clearEngineerSession(window.localStorage);
    setSession(null);
  };

  const signOut = async () => {
    const token = session?.token;
    forget();
    if (token) await signOutEngineer(token).catch(() => undefined);
  };

  if (isEngineerDesignPreview()) {
    return (
      <EngineerApp
        token=""
        fallbackEmail="alexandrasmirnova@gmail.com"
        designPreview
        onSignOut={() => undefined}
        onSessionExpired={() => undefined}
      />
    );
  }

  if (session) {
    return (
      <EngineerApp
        token={session.token}
        fallbackEmail={session.email}
        onSignOut={() => void signOut()}
        onSessionExpired={forget}
      />
    );
  }

  return (
    <main className="min-h-full bg-figma-canvas">
      <AuthToastLayer />
      <EngineerLogin motionOn={motionOn} onSession={accept} />
    </main>
  );
}
