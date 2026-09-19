import { useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { signOutDispatcher } from '../api/client';
import type { AuthSession } from '../api/types';
import { AuthToastLayer } from './AuthToastLayer';
import { FIGMA_ASSETS } from './assets';
import { ENGINEER_LOGIN_TITLE } from './loginCopy';
import { LoginCard } from './LoginCard';
import { FigmaIcon } from './primitives';

const ENGINEER_SESSION_KEY = 'lct.engineer.session';

type EngineerSession = {
  token: string;
  email: string;
  expiresAt: number;
};

function readEngineerSession(): EngineerSession | null {
  const raw = sessionStorage.getItem(ENGINEER_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EngineerSession;
    if (!parsed.token || !parsed.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Engineer sign-in at `/engineer`. The live engineer app is not on this branch yet,
 * so a successful code only keeps the session and a short confirmation card.
 */
export function EngineerAuthPage() {
  const motionOn = !useReducedMotion();
  const [session, setSession] = useState<EngineerSession | null>(() => readEngineerSession());

  const accept = (next: AuthSession, email: string) => {
    const stored = { token: next.token, email, expiresAt: next.expiresAt };
    sessionStorage.setItem(ENGINEER_SESSION_KEY, JSON.stringify(stored));
    setSession(stored);
  };

  const signOut = async () => {
    const token = session?.token;
    sessionStorage.removeItem(ENGINEER_SESSION_KEY);
    setSession(null);
    if (token) await signOutDispatcher(token).catch(() => undefined);
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-figma-canvas p-[32px]">
      <AuthToastLayer />
      {session ? (
        <div className="w-[480px] rounded-[20px] bg-white px-[36px] py-[36px] text-center">
          <div className="flex justify-center">
            <FigmaIcon src={FIGMA_ASSETS.logo} alt="LCT Smart Router" width={56} height={56} />
          </div>
          <h1 className="mt-[20px] font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
            {ENGINEER_LOGIN_TITLE}
          </h1>
          <p className="mt-[12px] font-semibold text-[18px] text-figma-ink">{session.email}</p>
          <p className="mt-[8px] font-medium text-[16px] leading-[22px] text-figma-muted">
            Сессия инженера открыта. Экран плана смены появится после стыковки ветки приложения.
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-[24px] flex h-[56px] w-full items-center justify-center rounded-[20px] bg-figma-danger font-semibold text-[18px] text-white"
          >
            Выйти
          </button>
        </div>
      ) : (
        <LoginCard role="engineer" motionOn={motionOn} submitting={false} onSession={accept} />
      )}
    </main>
  );
}
