import { motion } from 'framer-motion';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { requestDispatcherLoginCode, verifyDispatcherLoginCode } from '../api/client';
import { requestEngineerLoginCode, verifyEngineerLoginCode } from '../api/engineer';
import type { AuthSession } from '../api/types';
import { FIGMA_ASSETS } from './assets';
import {
  DISPATCHER_LOGIN_LEAD,
  DISPATCHER_LOGIN_TITLE,
  ENGINEER_LOGIN_LEAD,
  ENGINEER_LOGIN_TITLE,
  formatCodeCountdown,
  isLoginEmail,
  loginErrorMessage,
  remainingCodeSeconds,
} from './loginCopy';
import { applyOtpBackspace, applyOtpInput, emptyOtpCells, OTP_LENGTH, otpValue } from './otp';
import { FigmaIcon } from './primitives';
import { dismissToast, pushAuthErrorToast } from './toasts';

type LoginStep = 'email' | 'code' | 'password';
type LoginRole = 'engineer' | 'dispatcher';
type LoginSession = Pick<AuthSession, 'token' | 'expiresAt'>;

const fade = { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Shared engineer/dispatcher sign-in card: email → six digit cells, plus the
 * dispatcher password fallback on a separate step.
 */
export function LoginCard({
  loginRole: role,
  motionOn,
  submitting,
  onSession,
  onPassword,
}: {
  loginRole: LoginRole;
  motionOn: boolean;
  submitting: boolean;
  onSession: (session: LoginSession, email: string) => void | Promise<void>;
  onPassword?: (email: string, password: string) => Promise<void>;
}) {
  const title = role === 'engineer' ? ENGINEER_LOGIN_TITLE : DISPATCHER_LOGIN_TITLE;
  const lead = role === 'engineer' ? ENGINEER_LOGIN_LEAD : DISPATCHER_LOGIN_LEAD;
  const [step, setStep] = useState<LoginStep>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [cells, setCells] = useState(emptyOtpCells);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const code = otpValue(cells);
  const locked = busy || submitting;
  const remaining = expiresAt === null ? 0 : remainingCodeSeconds(expiresAt, nowMs);

  useEffect(() => {
    if (step !== 'code' || expiresAt === null || remaining <= 0) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt, remaining, step]);

  const showError = (cause: unknown) => {
    pushAuthErrorToast(loginErrorMessage(cause));
  };

  const requestCode = async () => {
    const nextEmail = email.trim();
    if (!isLoginEmail(nextEmail)) {
      pushAuthErrorToast('Проверьте адрес почты.');
      return;
    }
    setBusy(true);
    try {
      const issued = await (role === 'engineer'
        ? requestEngineerLoginCode(nextEmail)
        : requestDispatcherLoginCode(nextEmail));
      setEmail(issued.email);
      if (issued.devCode) setDevCode(issued.devCode);
      setExpiresAt(issued.expiresAt);
      setNowMs(Date.now());
      setCells(emptyOtpCells());
      setStep('code');
      dismissToast('auth-error');
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (nextCode = code) => {
    if (nextCode.length !== OTP_LENGTH || locked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const session = await (role === 'engineer'
        ? verifyEngineerLoginCode(email.trim(), nextCode)
        : verifyDispatcherLoginCode(email.trim(), nextCode));
      dismissToast('auth-error');
      await onSession(session, email.trim());
    } catch (cause) {
      showError(cause);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitPassword = async () => {
    if (!onPassword) return;
    const nextEmail = email.trim();
    if (!isLoginEmail(nextEmail) || !password) {
      pushAuthErrorToast(password ? 'Проверьте адрес почты.' : 'Введите пароль.');
      return;
    }
    setBusy(true);
    try {
      await onPassword(nextEmail, password);
      dismissToast('auth-error');
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative w-[480px] rounded-[20px] bg-white px-[36px] pb-[32px] pt-[36px]">
      <div className="flex justify-center">
        <FigmaIcon src={FIGMA_ASSETS.logo} alt="LCT Smart Router" width={56} height={56} />
      </div>
      <h1 className="mt-[20px] text-center font-extrabold text-[28px] tracking-[-0.476px] text-figma-ink">
        {title}
      </h1>
      {step === 'email' ? (
        <motion.form
          key="email"
          className="mt-[12px]"
          initial={motionOn ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={fade}
          onSubmit={(event) => {
            event.preventDefault();
            void requestCode();
          }}
        >
          <p className="text-center font-medium text-[16px] leading-[22px] text-figma-muted">
            {lead}
          </p>
          <Field label="Почта" htmlFor={`${role}-email`}>
            <input
              id={`${role}-email`}
              type="email"
              autoComplete="username"
              value={email}
              disabled={locked}
              onChange={(event) => setEmail(event.target.value)}
              className={fieldClass}
            />
          </Field>
          <PrimaryButton disabled={locked} label={locked ? 'Отправляем…' : 'Получить код'} />
          {role === 'dispatcher' && onPassword ? (
            <button
              type="button"
              disabled={locked}
              onClick={() => setStep('password')}
              className="mt-[16px] mx-auto block font-semibold text-[16px] text-figma-muted underline underline-offset-4"
            >
              Войти паролем
            </button>
          ) : null}
        </motion.form>
      ) : null}
      {step === 'code' ? (
        <motion.form
          key="code"
          className="mt-[12px]"
          initial={motionOn ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={fade}
          onSubmit={(event) => {
            event.preventDefault();
            void verify();
          }}
        >
          <p className="text-center font-semibold text-[18px] text-figma-ink">{email}</p>
          <OtpRow
            cells={cells}
            disabled={locked}
            onChange={(next, complete) => {
              setCells(next);
              if (complete) void verify(otpValue(next));
            }}
          />
          {devCode ? (
            <p className="mt-[12px] text-center font-medium text-[14px] text-figma-muted">
              Код для локальной отладки: {devCode}
            </p>
          ) : remaining > 0 ? (
            <p className="mt-[12px] text-center font-medium text-[14px] text-figma-muted">
              {formatCodeCountdown(remaining)}
            </p>
          ) : (
            <button
              type="button"
              disabled={locked}
              onClick={() => void requestCode()}
              className="mt-[12px] mx-auto block font-medium text-[14px] text-figma-muted underline underline-offset-4"
            >
              Получить новый код
            </button>
          )}
          <PrimaryButton
            disabled={locked || code.length !== OTP_LENGTH}
            label={locked ? 'Входим…' : 'Войти'}
          />
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setStep('email');
              setCells(emptyOtpCells());
              setDevCode(undefined);
              setExpiresAt(null);
              setPassword('');
            }}
            className="mt-[16px] mx-auto block font-semibold text-[16px] text-figma-muted underline underline-offset-4"
          >
            Сменить почту
          </button>
        </motion.form>
      ) : null}
      {step === 'password' ? (
        <motion.form
          key="password"
          className="mt-[12px]"
          initial={motionOn ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={fade}
          onSubmit={(event) => {
            event.preventDefault();
            void submitPassword();
          }}
        >
          <p className="text-center font-medium text-[16px] leading-[22px] text-figma-muted">
            Запасной вход по паролю диспетчера из окружения сервера.
          </p>
          <Field label="Почта" htmlFor={`${role}-password-email`}>
            <input
              id={`${role}-password-email`}
              type="email"
              autoComplete="username"
              value={email}
              disabled={locked}
              onChange={(event) => setEmail(event.target.value)}
              className={fieldClass}
            />
          </Field>
          <Field label="Пароль" htmlFor={`${role}-password`}>
            <input
              id={`${role}-password`}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={locked}
              onChange={(event) => setPassword(event.target.value)}
              className={fieldClass}
            />
          </Field>
          <PrimaryButton disabled={locked} label={locked ? 'Входим…' : 'Войти'} />
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setStep('email');
              setPassword('');
            }}
            className="mt-[16px] mx-auto block font-semibold text-[16px] text-figma-muted underline underline-offset-4"
          >
            Войти по коду
          </button>
        </motion.form>
      ) : null}
    </div>
  );
}

const fieldClass =
  'mt-[8px] h-[56px] w-full rounded-[20px] border border-figma-ink/15 bg-white px-[18px] font-medium text-[18px] tracking-[-0.3px] text-figma-ink outline-none placeholder:text-figma-hint focus:border-figma-ink';

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label className="mt-[20px] block font-semibold text-[16px] text-figma-ink" htmlFor={htmlFor}>
      {label}
      {children}
    </label>
  );
}

function PrimaryButton({ disabled, label }: { disabled: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className={`mt-[24px] flex h-[56px] w-full items-center justify-center rounded-[20px] font-semibold text-[18px] tracking-[-0.4px] text-figma-ink transition-transform duration-150 ${
        disabled ? 'bg-figma-track text-figma-hint' : 'bg-figma-bee hover:scale-[1.01]'
      }`}
    >
      {label}
    </button>
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
    <div className="mt-[20px] flex justify-center gap-[10px]">
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
          className="h-[56px] w-[52px] rounded-[16px] border border-figma-ink/15 bg-figma-canvas text-center font-extrabold text-[24px] text-figma-ink outline-none focus:border-figma-ink"
        />
      ))}
    </div>
  );
}
