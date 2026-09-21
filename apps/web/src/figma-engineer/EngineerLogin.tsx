import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useId, useRef, useState } from 'react';
import { requestEngineerLoginCode, verifyEngineerLoginCode } from '../api/engineer';
import type { EngineerAuthSession } from '../api/types';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import {
  isLoginEmail,
  loginErrorMessage,
  remainingCodeSeconds,
} from '../figma-dashboard/loginCopy';
import {
  applyOtpBackspace,
  applyOtpInput,
  emptyOtpCells,
  OTP_LENGTH,
  otpValue,
} from '../figma-dashboard/otp';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { dismissToast, pushAuthErrorToast } from '../figma-dashboard/toasts';
import { eu } from './engineerScale';
import { engineerCodeHint } from './loginHint';

const ease = [0.22, 1, 0.36, 1] as const;
const slide = { duration: 0.34, ease };

/**
 * Figma engineer login 80:9923 → 72:8710.
 * First: email + yellow «Войти». After a code is issued the button slides
 * down and widens into the black submit, the OTP cells fade in, and the
 * resend line is either a countdown, a local demo hint, or «Новый код».
 */
export function EngineerLogin({
  motionOn,
  onSession,
}: {
  motionOn: boolean;
  onSession: (session: EngineerAuthSession, email: string) => void | Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [cells, setCells] = useState(emptyOtpCells);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [codeStep, setCodeStep] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const code = otpValue(cells);
  const remaining = expiresAt === null ? 0 : remainingCodeSeconds(expiresAt, nowMs);
  const hint = engineerCodeHint({
    devCode,
    remainingSec: remaining,
    showDevCode: import.meta.env.DEV,
  });

  useEffect(() => {
    if (!codeStep || expiresAt === null || remaining <= 0 || devCode) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [codeStep, devCode, expiresAt, remaining]);

  const requestCode = async () => {
    const nextEmail = email.trim();
    if (!isLoginEmail(nextEmail)) {
      pushAuthErrorToast('Проверьте адрес почты.');
      return;
    }
    setBusy(true);
    try {
      const issued = await requestEngineerLoginCode(nextEmail);
      setEmail(issued.email);
      setDevCode(issued.devCode);
      setExpiresAt(issued.expiresAt);
      setNowMs(Date.now());
      setCells(emptyOtpCells());
      setCodeStep(true);
      dismissToast('auth-error');
    } catch (cause) {
      pushAuthErrorToast(loginErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (nextCode = code) => {
    if (nextCode.length !== OTP_LENGTH || busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const session = await verifyEngineerLoginCode(email.trim(), nextCode);
      dismissToast('auth-error');
      await onSession(session, email.trim());
    } catch (cause) {
      pushAuthErrorToast(loginErrorMessage(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="engineer-phone relative flex h-dvh flex-col overflow-y-auto bg-figma-canvas">
      <div
        className="flex flex-1 flex-col justify-center"
        style={{ padding: `${eu(40)} ${eu(52)}` }}
      >
        <div>
          <div className="flex flex-col items-center" style={{ gap: eu(32) }}>
            <FigmaIcon
              src={FIGMA_ASSETS.logo}
              alt=""
              width={170}
              height={170}
              style={{ width: eu(170), height: eu(170) }}
            />
            <p className="font-murs tracking-[0.02em] text-figma-ink" style={{ fontSize: eu(64) }}>
              NAVIX
            </p>
          </div>

          <form
            className="flex flex-col"
            style={{ marginTop: eu(80) }}
            onSubmit={(event) => {
              event.preventDefault();
              if (codeStep) {
                void verify();
                return;
              }
              void requestCode();
            }}
          >
            <label
              className="block font-murs text-figma-ink"
              htmlFor="eng-login-email"
              style={{ fontSize: eu(32) }}
            >
              Email
            </label>
            <input
              id="eng-login-email"
              type="email"
              autoComplete="username"
              placeholder="example@gmail.com"
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full bg-white font-medium text-figma-ink outline-none placeholder:text-figma-hint"
              style={{
                marginTop: eu(16),
                height: eu(96),
                borderRadius: eu(20),
                padding: `0 ${eu(29)}`,
                fontSize: eu(24),
              }}
            />

            <AnimatePresence initial={false}>
              {codeStep ? (
                <motion.div
                  key="otp"
                  initial={motionOn ? { opacity: 0, height: 0 } : false}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={motionOn ? { opacity: 0, height: 0 } : undefined}
                  transition={motionOn ? slide : { duration: 0 }}
                  className="overflow-hidden"
                >
                  <p
                    className="font-murs text-figma-ink"
                    style={{ marginTop: eu(40), fontSize: eu(32) }}
                  >
                    Код из письма
                  </p>
                  <OtpRow
                    cells={cells}
                    disabled={busy}
                    onChange={(next, complete) => {
                      setCells(next);
                      if (complete) void verify(otpValue(next));
                    }}
                  />
                  <div style={{ marginTop: eu(28) }}>
                    {hint.kind === 'demo' || hint.kind === 'countdown' ? (
                      <p
                        className="text-center font-medium text-figma-muted"
                        style={{ fontSize: eu(22), lineHeight: eu(28) }}
                      >
                        {hint.text}
                      </p>
                    ) : (
                      <motion.button
                        type="button"
                        disabled={busy}
                        onClick={() => void requestCode()}
                        whileTap={{ scale: 0.98 }}
                        className="mx-auto flex items-center justify-center bg-figma-bee font-semibold tracking-[-0.03em] text-figma-ink disabled:opacity-60"
                        style={{
                          width: eu(590),
                          maxWidth: '100%',
                          height: eu(76),
                          borderRadius: 999,
                          fontSize: eu(28),
                        }}
                      >
                        Новый код
                      </motion.button>
                    )}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <motion.button
              layout
              type="submit"
              disabled={busy || (codeStep && code.length !== OTP_LENGTH)}
              transition={motionOn ? slide : { duration: 0 }}
              className={`mx-auto flex items-center justify-center font-semibold tracking-[-0.03em] disabled:opacity-60 ${
                codeStep ? 'bg-figma-ink text-white' : 'bg-figma-bee text-figma-ink'
              }`}
              style={{
                marginTop: eu(40),
                width: codeStep ? eu(590) : eu(398),
                maxWidth: '100%',
                height: eu(76),
                borderRadius: 999,
                fontSize: eu(28),
              }}
            >
              {busy ? (codeStep ? 'Входим…' : 'Отправляем…') : 'Войти'}
            </motion.button>
          </form>
        </div>
      </div>
    </div>
  );
}

function OtpRow({
  cells,
  disabled,
  onChange,
}: {
  cells: string[];
  disabled: boolean;
  onChange: (cells: string[], complete: boolean) => void;
}) {
  const baseId = useId();
  const [slotIds] = useState(() =>
    Array.from({ length: OTP_LENGTH }, (_, index) => `${baseId}-${index}`),
  );
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    const filled = cells.findIndex((cell) => !cell);
    const index = filled === -1 ? OTP_LENGTH - 1 : filled === 0 ? 0 : filled;
    refs.current[index]?.focus();
  }, [cells]);

  return (
    <div className="flex" style={{ marginTop: eu(16), gap: eu(12) }}>
      {slotIds.map((slotId, index) => (
        <input
          key={slotId}
          ref={(node) => {
            refs.current[index] = node;
          }}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`Цифра ${index + 1} из ${OTP_LENGTH}`}
          maxLength={OTP_LENGTH}
          disabled={disabled}
          value={cells[index]}
          onChange={(event) => {
            const next = applyOtpInput(cells, index, event.target.value);
            refs.current[next.focus]?.focus();
            onChange(next.cells, otpValue(next.cells).length === OTP_LENGTH);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Backspace') return;
            event.preventDefault();
            const next = applyOtpBackspace(cells, index);
            refs.current[next.focus]?.focus();
            onChange(next.cells, false);
          }}
          className="min-w-0 flex-1 bg-white text-center font-extrabold text-figma-ink outline-none"
          style={{
            height: eu(96),
            maxWidth: eu(88),
            borderRadius: eu(20),
            fontSize: eu(32),
          }}
        />
      ))}
    </div>
  );
}
