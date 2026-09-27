import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useId, useRef, useState } from 'react';
import { FIGMA_ASSETS } from '../figma-dashboard/assets';
import {
  applyOtpBackspace,
  applyOtpInput,
  emptyOtpCells,
  OTP_LENGTH,
  otpValue,
} from '../figma-dashboard/otp';
import { FigmaIcon } from '../figma-dashboard/primitives';
import { eu } from '../figma-engineer/engineerScale';
import { engineerCodeHint } from '../figma-engineer/loginHint';
import { CLIENT_ASSETS } from './assets';

const ease = [0.22, 1, 0.36, 1] as const;
const slide = { duration: 0.34, ease };

/**
 * Client mailbox step, laid out like the engineer login.
 * Titles stay the client ones; the back control is the circular arrow.
 */
export function ClientEmailGate({
  purpose,
  email,
  codeStep,
  devCode,
  busy,
  notice,
  onEmailChange,
  onRequestCode,
  onConfirm,
  onClose,
}: {
  purpose: 'submit' | 'list' | 'detail' | 'support';
  email: string;
  codeStep: boolean;
  devCode?: string;
  busy: boolean;
  notice: string | null;
  onEmailChange: (email: string) => void;
  onRequestCode: () => void;
  onConfirm: (code: string) => void;
  onClose: () => void;
}) {
  const [cells, setCells] = useState(emptyOtpCells);
  const code = otpValue(cells);
  const title =
    purpose === 'submit'
      ? 'Подтвердите почту'
      : purpose === 'list' || purpose === 'support'
        ? 'Вход'
        : 'Откройте заявку';
  const lead =
    purpose === 'submit'
      ? 'Заявка создастся после кода из письма. До этого она не отправлена.'
      : purpose === 'support'
        ? 'Войдите кодом из письма, чтобы ассистент мог помочь с вашими заявками.'
        : 'Чтобы увидеть заявки этого адреса, войдите кодом из письма.';
  const hint = engineerCodeHint({
    devCode,
    remainingSec: 0,
    showDevCode: Boolean(devCode),
  });

  useEffect(() => {
    if (!codeStep) setCells(emptyOtpCells());
  }, [codeStep]);

  return (
    <section className="relative flex h-full flex-col overflow-y-auto bg-figma-canvas">
      <button
        type="button"
        aria-label="Назад"
        onClick={onClose}
        className="absolute"
        style={{ top: eu(28), left: eu(28), width: eu(86), height: eu(86) }}
      >
        <FigmaIcon
          src={CLIENT_ASSETS.backCircle}
          alt=""
          width={43}
          height={43}
          style={{ width: eu(86), height: eu(86) }}
        />
      </button>
      <div
        className="flex flex-1 flex-col justify-center"
        style={{ padding: `${eu(40)} ${eu(52)}` }}
      >
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
          style={{ marginTop: eu(48) }}
          onSubmit={(event) => {
            event.preventDefault();
            if (codeStep) onConfirm(code);
            else onRequestCode();
          }}
        >
          <h1 className="font-murs text-figma-ink" style={{ fontSize: eu(40) }}>
            {title}
          </h1>
          <p
            className="font-medium text-figma-muted"
            style={{ marginTop: eu(12), fontSize: eu(20), lineHeight: eu(28) }}
          >
            {lead}
          </p>
          <label
            className="block font-murs text-figma-ink"
            htmlFor="client-gate-email"
            style={{ marginTop: eu(32), fontSize: eu(32) }}
          >
            Email
          </label>
          <input
            id="client-gate-email"
            type="email"
            autoComplete="email"
            placeholder="example@gmail.com"
            value={email}
            readOnly={purpose === 'submit' || codeStep}
            disabled={busy}
            onChange={(event) => onEmailChange(event.target.value)}
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
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={slide}
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
                    if (complete) onConfirm(otpValue(next));
                  }}
                />
                <div style={{ marginTop: eu(28) }}>
                  {hint.kind === 'demo' ? (
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
                      onClick={onRequestCode}
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

          {notice ? (
            <p
              className="font-medium text-figma-muted"
              style={{ marginTop: eu(16), fontSize: eu(18), lineHeight: eu(24) }}
            >
              {notice}
            </p>
          ) : null}

          <motion.button
            layout
            type="submit"
            disabled={busy || (codeStep && code.length !== OTP_LENGTH)}
            transition={slide}
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
            {busy
              ? codeStep
                ? 'Входим…'
                : 'Отправляем…'
              : codeStep
                ? 'Подтвердить'
                : 'Получить код'}
          </motion.button>
        </form>
      </div>
    </section>
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
