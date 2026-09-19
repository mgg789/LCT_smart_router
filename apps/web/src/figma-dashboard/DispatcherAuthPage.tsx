import { useReducedMotion } from 'framer-motion';
import { AuthToastLayer } from './AuthToastLayer';
import { LoginCard } from './LoginCard';

/**
 * Dispatcher sign-in shown on `/` when there is no live or demo session.
 */
export function DispatcherAuthPage({
  submitting,
  onSession,
  onPassword,
}: {
  submitting: boolean;
  onSession: (token: string, expiresAt: number) => void;
  onPassword: (email: string, password: string) => Promise<void>;
}) {
  const motionOn = !useReducedMotion();
  return (
    <main className="flex min-h-full items-center justify-center bg-figma-canvas p-[32px]">
      <AuthToastLayer />
      <LoginCard
        role="dispatcher"
        motionOn={motionOn}
        submitting={submitting}
        onSession={(session) => onSession(session.token, session.expiresAt)}
        onPassword={onPassword}
      />
    </main>
  );
}
