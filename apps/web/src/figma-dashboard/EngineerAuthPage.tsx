import { useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { signOutEngineer } from '../api/engineer';
import type { EngineerAuthSession } from '../api/types';
import { isEngineerDesignPreview } from '../figma-engineer/designPreview';
import { EngineerApp } from '../figma-engineer/EngineerApp';
import { EngineerLogin } from '../figma-engineer/EngineerLogin';
import { usePhoneDesk } from '../figma-engineer/phoneDesk';
import {
  clearEngineerSession,
  readEngineerSession,
  writeEngineerSession,
} from '../figma-engineer/session';
/**
 * Engineer sign-in at `/engineer`. A live session opens the Figma day list.
 */
export function EngineerAuthPage() {
  const motionOn = !useReducedMotion();
  const desk = usePhoneDesk();
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
      {/* On a desk the sign-in takes the same column width as the customer's gate and
          as the app it opens into. Left at the phone's own 430 it sat as a thin strip
          in the middle of a desktop window, narrower than everything that follows. */}
      <div className={desk ? 'phone-desk-sheet min-h-full' : 'min-h-full'}>
        <EngineerLogin motionOn={motionOn} onSession={accept} />
      </div>
    </main>
  );
}
